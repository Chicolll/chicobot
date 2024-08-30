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

// In-memory conversation storage (Note: this will reset on each deployment)
const conversations = new Map();

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

// Function to log conversations (in-memory only for Vercel)
function logConversation(threadId, message, role, ip) {
  if (!conversations.has(threadId)) {
    conversations.set(threadId, {
      messages: [],
      startTime: new Date().toLocaleString("en-US", {timeZone: "America/Los_Angeles"}),
      ip: ip
    });
  }
  conversations.get(threadId).messages.push({ role, content: message });
  console.log(`Logged message for thread ${threadId}: ${role}: ${message}`);
}

// Function to send email
async function sendEmailNotification(threadId) {
  const conversation = conversations.get(threadId);
  if (!conversation || conversation.messages.length === 0) {
    console.log(`No conversation to send for thread ${threadId}`);
    return;
  }

  const location = await getLocationFromIP(conversation.ip);
  const endTime = new Date().toLocaleString("en-US", {timeZone: "America/Los_Angeles"});
  const duration = (new Date(endTime) - new Date(conversation.startTime)) / 1000; // duration in seconds

  const emailContent = `
IP Address: ${conversation.ip}
Location: ${location}
Start Time: ${conversation.startTime} (California Time)
End Time: ${endTime} (California Time)
Duration: ${Math.floor(duration / 60)} minutes ${Math.floor(duration % 60)} seconds

Conversation:
${conversation.messages.map(msg => `${msg.role}: ${msg.content}`).join('\n\n')}
  `;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.NOTIFICATION_EMAIL,
    subject: `Conversation from ${location}`,
    text: emailContent
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email sent for thread ${threadId}`);
    // Clear the conversation after sending email
    conversations.delete(threadId);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/chat', async (req, res) => {
  try {
    console.log("Received chat request:", req.body);
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
    console.log("Added user message to thread");

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Send the 'start'
