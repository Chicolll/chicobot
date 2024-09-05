import express from 'express';
import OpenAI from 'openai';
import cors from 'cors';
import nodemailer from 'nodemailer';
import fetch from 'node-fetch';

const app = express();
app.use(cors({
  origin: ['https://www.chicoliu.com', 'https://www.chicoliu.webflow.io']
}));
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const assistantId = 'asst_cplmQJp8j0qKyABmqM1EWfLt';

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// In-memory conversation storage (Note: this will reset on each deployment)
let conversations = new Map();

// Timeout for conversations (10 seconds as requested)
const CONVERSATION_TIMEOUT = 10 * 1000; // 10 seconds in milliseconds

// Function to get location from IP using freeipapi.com
async function getLocationFromIP(ip) {
  try {
    const response = await fetch(`https://freeipapi.com/api/json/${ip}`);
    const data = await response.json();
    return `${data.cityName}, ${data.regionName}, ${data.countryName}`;
  } catch (error) {
    console.error('Error fetching location:', error);
    return 'Unknown Location';
  }
}

// Function to log conversations
function logConversation(threadId, message, role, ip) {
  console.log(`Logging conversation for thread ${threadId}`);
  if (!conversations.has(threadId)) {
    conversations.set(threadId, {
      messages: [],
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      ip: ip
    });
  }
  
  const conversation = conversations.get(threadId);
  conversation.messages.push({ role, content: message });
  conversation.lastActivityTime = Date.now();
  
  console.log(`Logged message for thread ${threadId}: ${role}: ${message}`);
}

// Function to send email
async function sendEmailNotification(threadId, reason) {
  console.log(`Preparing to send email for thread ${threadId}`);
  const conversation = conversations.get(threadId);
  if (!conversation || conversation.messages.length === 0) {
    console.log(`No conversation to send for thread ${threadId}`);
    return;
  }

  const location = await getLocationFromIP(conversation.ip);
  const startTime = new Date(conversation.startTime).toLocaleString("en-US", {timeZone: "America/Los_Angeles"});
  const endTime = new Date().toLocaleString("en-US", {timeZone: "America/Los_Angeles"});
  const duration = (Date.now() - conversation.startTime) / 1000; // duration in seconds

  const emailContent = `
IP Address: ${conversation.ip}
Location: ${location}
Start Time: ${startTime} (California Time)
End Time: ${endTime} (California Time)
Duration: ${Math.floor(duration / 60)} minutes ${Math.floor(duration % 60)} seconds
Reason for ending: ${reason}

Conversation:
${conversation.messages.map(msg => `${msg.role}: ${msg.content}`).join('\n\n')}
  `;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.NOTIFICATION_EMAIL,
    subject: `Conversation from ${location} - ${reason}`,
    text: emailContent
  };

  return new Promise((resolve, reject) => {
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error(`Error sending email for thread ${threadId}:`, error);
        reject(error);
      } else {
        console.log(`Email sent for thread ${threadId}: ${info.response}`);
        resolve(info);
      }
    });
  });
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, threadId } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    let thread;
    if (threadId) {
      thread = await openai.beta.threads.retrieve(threadId);
      console.log("Retrieved existing thread:", thread.id);
    } else {
      thread = await openai.beta.threads.create();
      console.log("Created new thread:", thread.id);
    }

    // Log user message
    logConversation(thread.id, message, 'user', ip);

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId
    });

    // Wait for the run to complete
    let runStatus;
    do {
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
    } while (runStatus.status !== 'completed');

    // Retrieve messages after the run
    const messages = await openai.beta.threads.messages.list(thread.id);

    // Get the last assistant message
    const lastAssistantMessage = messages.data
      .filter(msg => msg.role === 'assistant')
      .pop();

    if (lastAssistantMessage) {
      logConversation(thread.id, lastAssistantMessage.content[0].text.value, 'assistant', ip);
    }

    res.json({
      threadId: thread.id,
      message: lastAssistantMessage ? lastAssistantMessage.content[0].text.value : "No response from assistant."
    });
  } catch (error) {
    console.error('Error in chat:', error);
    res.status(500).json({ error: 'An error occurred while processing your request.' });
  }
});

app.get('/api/checkTimeouts', async (req, res) => {
  console.log('Checking all conversations');
  const now = Date.now();
  for (const [threadId, conversation] of conversations.entries()) {
    const inactiveDuration = now - conversation.lastActivityTime;

    console.log(`Thread ${threadId} - Inactive duration: ${inactiveDuration}ms, Last activity: ${new Date(conversation.lastActivityTime).toISOString()}`);

    if (inactiveDuration >= CONVERSATION_TIMEOUT) {
      console.log(`Ending conversation ${threadId} due to inactivity timeout`);
      try {
        await sendEmailNotification(threadId, 'Inactivity timeout');
        conversations.delete(threadId);
        console.log(`Conversation ${threadId} ended and removed from memory`);
      } catch (error) {
        console.error(`Error ending conversation ${threadId}:`, error);
      }
    }
  }
  res.status(200).send('Timeout check completed');
});

app.post('/api/reset', async (req, res) => {
  try {
    const { threadId } = req.body;
    if (threadId) {
      await openai.beta.threads.del(threadId);
      console.log("Deleted thread:", threadId);
      
      // Send final email notification before resetting
      await sendEmailNotification(threadId, 'Manual reset');
      // Clear the conversation from memory
      conversations.delete(threadId);
    }
    const newThread = await openai.beta.threads.create();
    console.log("Created new thread:", newThread.id);
    res.json({ message: 'Chat reset successfully', threadId: newThread.id });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while resetting the chat.' });
  }
});

app.post('/api/end-conversation', async (req, res) => {
  try {
    const { threadId } = req.body;
    if (threadId) {
      await sendEmailNotification(threadId, 'Manual end');
      // Clear the conversation from memory
      conversations.delete(threadId);
      res.json({ message: 'Conversation ended and email sent successfully' });
    } else {
      res.status(400).json({ error: 'ThreadId is required' });
    }
  } catch (error) {
    console.error('Error ending conversation:', error);
    res.status(500).json({ error: 'An error occurred while ending the conversation.' });
  }
});

// Test route for email sending
app.get('/api/test-email', async (req, res) => {
  try {
    await sendEmailNotification('test_thread', 'Test email');
    res.send('Test email sent successfully');
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).send('Error sending test email');
  }
});

module.exports = app;
