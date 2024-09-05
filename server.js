import express from 'express';
import OpenAI from 'openai';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import fetch from 'node-fetch';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({
  origin: ['https://www.chicoliu.com', 'https://www.chicoliu.webflow.io']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// In-memory conversation storage
const conversations = new Map();

// Timeout for conversations (10 seconds as requested)
const CONVERSATION_TIMEOUT = 10 * 1000; // 10 seconds in milliseconds

// Maximum session duration (90 minutes)
const MAX_SESSION_DURATION = 90 * 60 * 1000; // 90 minutes in milliseconds

// Interval for checking conversations (every 5 seconds)
const CHECK_INTERVAL = 5 * 1000; // 5 seconds in milliseconds

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
    console.log(`Creating new conversation for thread ${threadId}`);
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
  console.log(`Updated lastActivityTime for thread ${threadId}: ${conversation.lastActivityTime}`);
}

// Function to check and end conversations if necessary
async function checkConversations() {
  console.log('Checking all conversations');
  const now = Date.now();
  for (const [threadId, conversation] of conversations.entries()) {
    const inactiveDuration = now - conversation.lastActivityTime;
    const totalDuration = now - conversation.startTime;

    console.log(`Thread ${threadId} - Inactive duration: ${inactiveDuration}ms, Total duration: ${totalDuration}ms, Last activity: ${new Date(conversation.lastActivityTime).toISOString()}`);

    if (inactiveDuration >= CONVERSATION_TIMEOUT || totalDuration >= MAX_SESSION_DURATION) {
      const reason = inactiveDuration >= CONVERSATION_TIMEOUT ? 'Inactivity timeout' : 'Max session duration reached';
      console.log(`Ending conversation ${threadId} due to ${reason}`);
      try {
        await sendEmailNotification(threadId, reason);
        conversations.delete(threadId);
        console.log(`Conversation ${threadId} ended and removed from memory`);
      } catch (error) {
        console.error(`Error ending conversation ${threadId}:`, error);
      }
    }
  }
}

// Set up interval to check conversations
setInterval(checkConversations, CHECK_INTERVAL);

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

// ... [rest of the code remains the same] ...

// Test route for email sending
app.get('/test-email', async (req, res) => {
  try {
    await sendEmailNotification('test_thread', 'Test email');
    res.send('Test email sent successfully');
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).send('Error sending test email');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));

export default app;
