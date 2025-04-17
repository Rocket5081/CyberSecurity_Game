// Chat functionality
document.addEventListener('DOMContentLoaded', function() {
    console.log("Chat module loaded");
    
    // Initialize chat when user is logged in
    socket.on('loginResponse', (response) => {
        if (response.success) {
            initChat();
        }
    });
    
    // Initialize existing chat if user is already logged in
    if (currentUser) {
        initChat();
    }
});

function initChat() {
    console.log("Initializing chat for user:", currentUser);
    
    // Check if chat container already exists
    let chatContainer = document.getElementById('chat-container');
    
    // If not, create it
    if (!chatContainer) {
        // Create chat container
        chatContainer = document.createElement('div');
        chatContainer.id = 'chat-container';
        chatContainer.className = 'chat-container';
        chatContainer.innerHTML = `
            <h3>Chat</h3>
            <div id="chat-messages"></div>
            <div class="chat-input-container">
                <input type="text" id="chat-input" placeholder="Type a message...">
                <button id="send-chat">Send</button>
            </div>
        `;
        
        // Add to main menu
        const mainMenu = document.getElementById('main-menu');
        mainMenu.appendChild(chatContainer);
        
        // Set up event listeners
        setupChatEventListeners();
    }
    
    // Register for chat messages
    setupChatSocketListeners();
}

function setupChatEventListeners() {
    console.log("Setting up chat event listeners");
    
    // Send button click
    document.getElementById('send-chat').addEventListener('click', sendChatMessage);
    
    // Enter key press in input field
    document.getElementById('chat-input').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            sendChatMessage();
        }
    });
}

function setupChatSocketListeners() {
    console.log("Setting up chat socket listeners");
    
    // Remove any existing listeners to avoid duplicates
    socket.off('chatMessage');
    
    // Register for chat messages
    socket.on('chatMessage', (data) => {
        console.log("Received chat message:", data);
        displayChatMessage(data);
    });
}

function sendChatMessage() {
    const inputElement = document.getElementById('chat-input');
    const message = inputElement.value.trim();
    
    console.log("Attempting to send message:", message);
    
    if (message && currentUser) {
        console.log("Sending chat message:", message, "as user:", currentUser.username);
        
        socket.emit('chatMessage', {
            username: currentUser.username,
            message: message
        });
        
        // Clear input field
        inputElement.value = '';
    }
}

function displayChatMessage(data) {
    const chatMessages = document.getElementById('chat-messages');
    const messageElement = document.createElement('div');
    messageElement.className = 'chat-message';
    
    // Highlight current user's messages
    if (currentUser && data.username === currentUser.username) {
        messageElement.className += ' own-message';
    }
    
    messageElement.innerHTML = `<strong>${data.username}:</strong> ${data.message}`;
    chatMessages.appendChild(messageElement);
    
    // Auto-scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}