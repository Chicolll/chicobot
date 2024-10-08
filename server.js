import express from 'express';
import OpenAI from 'openai';
import cors from 'cors';
import nodemailer from 'nodemailer';
import fetch from 'node-fetch';

const app = express();
app.use(cors({
  origin: ['https://www.chicoliu.com', 'https://www.chicoliu.webflow.io', 'http://localhost:3000']
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

// Root route
app.get('/', (req, res) => {
  res.send('Chico Bot Server is running');
});

// Chat route
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

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Function to send SSE
    const sendSSE = (event, data) => {
      res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
    };

    // Start event
    sendSSE('start', { message: 'Starting chat' });

    // Check run status and stream response
    while (true) {
      const runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(thread.id);
        const lastMessage = messages.data[0];
        if (lastMessage.role === 'assistant') {
          const content = lastMessage.content[0].text.value;
          // Stream the content word by word
          const words = content.split(' ');
          for (let word of words) {
            sendSSE('delta', { content: word + ' ' });
            await new Promise(resolve => setTimeout(resolve, 50)); // Small delay between words
          }
          logConversation(thread.id, content, 'assistant', ip);
        }
        break;
      } else if (runStatus.status === 'failed') {
        sendSSE('error', { message: 'Run failed' });
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // End event
    sendSSE('end', { threadId: thread.id });
    res.end();

  } catch (error) {
    console.error('Error in chat:', error);
    res.status(500).json({ error: 'An error occurred while processing your request.' });
  }
});

// Reset route
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

// New endpoint for GitHub Action
app.post('/api/check-and-send-emails', async (req, res) => {
  const secretToken = req.headers['x-git-token'];
  if (secretToken !== process.env.GIT_SECRET_TOKEN) {
    return res.status(403).send('Unauthorized');
  }

  console.log('Checking all conversations');
  const now = Date.now();
  const inactiveThreads = [];

  for (const [threadId, conversation] of conversations.entries()) {
    const inactiveDuration = now - conversation.lastActivityTime;
    console.log(`Thread ${threadId} - Inactive duration: ${inactiveDuration}ms`);

    if (inactiveDuration >= 10 * 60 * 1000) { // 10 minutes inactivity
      inactiveThreads.push(threadId);
    }
  }

  for (const threadId of inactiveThreads) {
    try {
      await sendEmailNotification(threadId, 'Inactivity timeout');
      conversations.delete(threadId);
      console.log(`Processed inactive thread ${threadId}`);
    } catch (error) {
      console.error(`Error processing inactive thread ${threadId}:`, error);
    }
  }

  res.status(200).send(`Processed ${inactiveThreads.length} inactive threads`);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));

export default app;
