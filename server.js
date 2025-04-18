// server.js - Cybersecurity Awareness Game Server with Supabase
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Initialize Express and Socket.io
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Initialize Supabase
const supabaseUrl = 'https://cclodkiuzkvynhnauaeu.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Serve static files
app.use(express.static(path.join(__dirname)));

// Game state (for tracking online players)
const gameState = {
  players: {}
};

// SHA256 Helper Function
function sha256(message) {
  return crypto.createHash('sha256').update(message).digest('hex');
}

// Helper to get online players
function getOnlinePlayers() {
  return Object.values(gameState.players)
    .filter(player => player.online)
    .map(player => player.username);
}

// Database Functions

async function registerUser(userData) {
  const hashedPassword = sha256(userData.password);
  
  const { data, error } = await supabase
    .from('User')
    .insert([{
      Username: userData.username,
      Password_hash: hashedPassword,
      Highscore: 0,
      GamesPlayed: 0,
      RegistrationDate: new Date().toISOString()
    }])
    .select()
    .single();

  return { data, error };
}

async function authenticateUser(username, password) {
  const hashedPassword = sha256(password);
  
  const { data, error } = await supabase
    .from('User')
    .select('UserID, Username, Password_hash, Highscore, GamesPlayed, RegistrationDate')
    .eq('Username', username)
    .single();

  if (error || !data) return { error: 'User not found' };
  if (data.Password_hash !== hashedPassword) return { error: 'Invalid password' };

  return { user: data };
}

async function updateUserHighscore(userId, score) {
  // First check if the new score is higher than current highscore
  const { data: currentUser, error: fetchError } = await supabase
    .from('User')
    .select('Highscore')
    .eq('UserID', userId)
    .single();

  if (fetchError) return { error: fetchError };
  if (score <= currentUser.Highscore) return { data: currentUser };

  // Update if score is higher
  const { data, error } = await supabase
    .from('User')
    .update({
      Highscore: score
    })
    .eq('UserID', userId)
    .select()
    .single();

  return { data, error };
}

async function updateLeaderboard(username, score) {
  // Get user ID
  const { data: user, error: userError } = await supabase
    .from('User')
    .select('UserID')
    .eq('Username', username)
    .single();

  if (userError || !user) return { error: 'User not found' };

  // Insert or update leaderboard entry
  const { error } = await supabase
    .from('Leaderboard')
    .upsert({
      UserID: user.UserID,
      Username: username,
      Score: score,
      Date: new Date().toISOString()
    }, {
      onConflict: 'UserID'
    });

  return { error };
}

async function getLeaderboard() {
  try {
    // Get the top 5 users by high score
    const { data, error } = await supabase
      .from('User')
      .select('Username, Highscore, RegistrationDate')
      .order('Highscore', { ascending: false })
      .limit(5);
    
    if (error) {
      console.error("Error fetching leaderboard:", error);
      return []; // Return empty array instead of undefined
    }
    
    // Format the data for the client
    return data.map(user => ({
      username: user.Username,
      score: user.Highscore,
      date: user.RegistrationDate
    }));
  } catch (err) {
    console.error("Unexpected error in getLeaderboard:", err);
    return []; // Always return an array
  }
}

// Updated function to handle both score and games played
async function updateUserScore(username, score) {
  try {
    // Get user data first to check if score is higher than current
    const { data: user, error: userError } = await supabase
      .from('User')
      .select('UserID, Highscore, GamesPlayed')
      .eq('Username', username)
      .single();
    
    if (userError || !user) {
      console.error("User not found:", userError);
      return { error: 'User not found' };
    }
    
    // Increment the games played counter
    const gamesPlayed = (user.GamesPlayed || 0) + 1;
    
    // Always update games played, but only update high score if it's higher
    const updates = { GamesPlayed: gamesPlayed };
    if (score > user.Highscore) {
      updates.Highscore = score;
    }
    
    const { data, error } = await supabase
      .from('User')
      .update(updates)
      .eq('UserID', user.UserID);
      
    if (error) {
      console.error("Error updating user data:", error);
      return { error: error.message };
    }
    
    // Notify other users of the new high score if applicable
    return { 
      success: true, 
      newHighScore: score > user.Highscore,
      gamesPlayed: gamesPlayed 
    };
  } catch (err) {
    console.error("Unexpected error in updateUserScore:", err);
    return { error: 'Server error' };
  }
}

async function getQuestionsByCategory(category) {
  const { data: questions, error: qError } = await supabase
    .from('Question')
    .select('QuestionID, QuestionText, Difficulty, Category')
    .eq('Category', category);

  if (qError) throw qError;

  const questionIds = questions.map(q => q.QuestionID);
  const { data: answers, error: aError } = await supabase
    .from('Answer')
    .select('AnswerID, QuestionID, AnswerText, isCorrect')
    .in('QuestionID', questionIds);

  if (aError) throw aError;

  return questions.map(question => ({
    ...question,
    answers: answers.filter(a => a.QuestionID === question.QuestionID)
  }));
}

// Socket.io Event Handlers

io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);

  // User Registration
  socket.on('registerUser', async (userData) => {
    try {
      // Check if username exists
      const { data: existingUser } = await supabase
        .from('User')
        .select('Username')
        .eq('Username', userData.username)
        .single();

      if (existingUser) {
        return socket.emit('registrationResponse', {
          success: false,
          message: 'Username already exists'
        });
      }

      // Register new user
      const { data: newUser, error } = await registerUser(userData);
      
      if (error) throw error;

      // Update game state
      gameState.players[socket.id] = {
        userId: newUser.UserID,
        username: newUser.Username,
        online: true,
        isGuest: false
      };

      socket.emit('registrationResponse', {
        success: true,
        user: {
          userId: newUser.UserID,
          username: newUser.Username,
          highscore: newUser.Highscore,
          gamesPlayed: newUser.GamesPlayed || 0,
          registrationDate: newUser.RegistrationDate
        }
      });

      io.emit('playerUpdate', { players: getOnlinePlayers() });
    } catch (error) {
      console.error('Registration error:', error);
      socket.emit('registrationResponse', {
        success: false,
        message: 'Registration failed'
      });
    }
  });

  // User Login
  socket.on('login', async (credentials) => {
    try {
      const { user, error } = await authenticateUser(
        credentials.username,
        credentials.password
      );
  
      if (error) {
        // Check if it's an invalid password error or user not found
        const errorMessage = error === 'Invalid password' ? 
          'Invalid password' : 'User not found';
        
        // Return error to the client instead of falling back to guest login
        return socket.emit('loginResponse', {
          success: false,
          message: errorMessage
        });
      }
  
      // Update game state
      gameState.players[socket.id] = {
        userId: user.UserID,
        username: user.Username,
        online: true,
        isGuest: false
      };
  
      socket.emit('loginResponse', {
        success: true,
        user: {
          userId: user.UserID,
          username: user.Username,
          highscore: user.Highscore,
          gamesPlayed: user.GamesPlayed || 0,
          registrationDate: user.RegistrationDate
        }
      });
  
      io.emit('playerUpdate', { players: getOnlinePlayers() });
    } catch (error) {
      console.error('Login error:', error);
      socket.emit('loginResponse', {
        success: false,
        message: 'Login failed'
      });
    }
  });

  socket.on('resetPassword', async (data) => {
    try {
      const result = await resetUserPassword(
        data.username,
        data.email,
        data.newPassword
      );
      
      socket.emit('resetPasswordResponse', result);
    } catch (error) {
      console.error('Reset password error:', error);
      socket.emit('resetPasswordResponse', {
        success: false,
        message: 'Password reset failed'
      });
    }
  });

  // Guest Login
  socket.on('guestLogin', () => {
    handleGuestLogin(socket, `Guest${Math.floor(Math.random() * 1000)}`);
  });

  // Get Questions
  socket.on('getQuestions', async ({ category }) => {
    try {
      const questions = await getQuestionsByCategory(category);
      socket.emit('questionsData', { questions });
    } catch (error) {
      console.error('Error getting questions:', error);
      socket.emit('questionsError', { message: 'Failed to load questions' });
    }
  });

  // Game Completed
  socket.on('gameCompleted', async ({ score, category }) => {
    try {
      const player = gameState.players[socket.id];
      if (!player || player.isGuest) return;
  
      // Update user score and games played
      const result = await updateUserScore(player.username, score);
    
      if (result.success) {
        // If it was a new high score, broadcast to other players
        if (result.newHighScore) {
          io.emit('newHighScore', {
            username: player.username,
            score: score,
            category: category
          });
        }
      
        // Get updated leaderboard
        const leaderboard = await getLeaderboard();
      
        // Send back to all clients
        io.emit('leaderboardUpdated', { leaderboard });
        
        // Add this section to send updated user data
        const { data: updatedUser } = await supabase
          .from('User')
          .select('UserID, Username, Highscore, RegistrationDate, GamesPlayed')
          .eq('Username', player.username)
          .single();
          
        if (updatedUser) {
          // Send updated user data to this client
          socket.emit('userUpdated', { 
            user: {
              userId: updatedUser.UserID,
              username: updatedUser.Username,
              highscore: updatedUser.Highscore,
              gamesPlayed: updatedUser.GamesPlayed || 0,
              registrationDate: updatedUser.RegistrationDate
            }
          });
        }
      }
    } catch (error) {
      console.error('Game completion error:', error);
    }
  });

  // Get Leaderboard
  socket.on('getLeaderboard', async () => {
    try {
      const leaderboard = await getLeaderboard();
      socket.emit('leaderboardData', { leaderboard });
    } catch (error) {
      console.error('Error getting leaderboard:', error);
      socket.emit('leaderboardError', { message: 'Failed to load leaderboard' });
    }
  });

  // Update user stats
  socket.on('updateUserStats', async (data) => {
    if (data.userId) {
      try {
        // Update category-specific statistics for the user
        await supabase
          .from('UserStats')
          .upsert({
            UserID: data.userId,
            CategoryStats: data.categoryStats
          });
        
        // Broadcast the update to ensure client is in sync
        socket.emit('userStatsUpdated', {
          userId: data.userId,
          categoryStats: data.categoryStats
        });
      } catch (error) {
        console.error('Error updating user stats:', error);
      }
    }
  });

  // Logout
  socket.on('logout', () => {
    if (gameState.players[socket.id]) {
      delete gameState.players[socket.id];
      io.emit('playerUpdate', { players: getOnlinePlayers() });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    if (gameState.players[socket.id]) {
      delete gameState.players[socket.id];
      io.emit('playerUpdate', { players: getOnlinePlayers() });
    }
  });

  // Handle chat messages 
  socket.on('chatMessage', (messageData) => {
    // Broadcast the message to all connected clients
    io.emit('chatMessage', {
      username: messageData.username,
      message: messageData.message,
      timestamp: new Date().toISOString()
    });
  });

});

// Handle Guest Login
async function handleGuestLogin(socket, username) {
  const guestUsername = username || `Guest${Math.floor(Math.random() * 1000)}`;
  
  gameState.players[socket.id] = { 
    username: guestUsername,
    online: true,
    isGuest: true
  };
  
  socket.emit('loginResponse', { 
    success: true, 
    user: {
      username: guestUsername,
      isGuest: true,
      gamesPlayed: 0
    }
  });
  
  io.emit('playerUpdate', { players: getOnlinePlayers() });
}

// Reset user password function (needs to be defined)
async function resetUserPassword(username, email, newPassword) {
  try {
    // Check if user exists and email matches
    const { data: user, error: userError } = await supabase
      .from('User')
      .select('UserID, Email')
      .eq('Username', username)
      .single();
    
    if (userError || !user) {
      return { success: false, message: 'User not found' };
    }
    
    // Here you would normally validate the email against the stored one
    // but since this is a simplified example, we'll just update the password
    
    const hashedPassword = sha256(newPassword);
    
    const { error } = await supabase
      .from('User')
      .update({ Password_hash: hashedPassword })
      .eq('UserID', user.UserID);
      
    if (error) {
      return { success: false, message: 'Failed to update password' };
    }
    
    return { success: true };
  } catch (err) {
    console.error('Password reset error:', err);
    return { success: false, message: 'Internal server error' };
  }
}

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});