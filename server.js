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

// In-memory conversation storage
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

// Existing routes and functions...

// New route to handle the page close signal
app.post('/api/signal-close', async (req, res) => {
  const { threadId } = req.body;
  console.log(`Received close signal for thread ${threadId}`);
  
  if (threadId) {
    try {
      await sendEmailNotification(threadId, 'Page closed');
      conversations.delete(threadId);
      console.log(`Processed close signal for thread ${threadId}`);
      res.status(200).send('Close signal received and processed');
    } catch (error) {
      console.error(`Error processing close signal for thread ${threadId}:`, error);
      res.status(500).send('Error processing close signal');
    }
  } else {
    res.status(400).send('ThreadId is required');
  }
});

// Existing chat route
app.post('/api/chat', async (req, res) => {
  // ... (existing chat logic)
});

// Existing reset route
app.post('/api/reset', async (req, res) => {
  // ... (existing reset logic)
});

// Ping route to keep the connection alive
app.post('/api/ping', (req, res) => {
  const { threadId } = req.body;
  if (threadId && conversations.has(threadId)) {
    conversations.get(threadId).lastActivityTime = Date.now();
    res.status(200).send('Ping received');
  } else {
    res.status(404).send('Thread not found');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));

export default app;
