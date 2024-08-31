import express from 'express';
import OpenAI from 'openai';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import fetch from 'node-fetch';
import session from 'express-session';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors({
  origin: ['https://www.chicoliu.com', 'https://www.chicoliu.webflow.io'],
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const assistantId = 'asst_cplmQJp8j0qKyABmqM1EWfLt';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const conversations = new Map();

const CONVERSATION_TIMEOUT = 15 * 1000; // 15 seconds for testing

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

function logConversation(sessionId, message, role, ip) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, {
      messages: [],
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      ip: ip,
      timeoutId: null
    });
  } else {
    clearTimeout(conversations.get(sessionId).timeoutId);
  }
  
  const conversation = conversations.get(sessionId);
  conversation.messages.push({ role, content: message });
  conversation.lastActivityTime = Date.now();
  
  conversation.timeoutId = setTimeout(() => {
    sendEmailNotification(sessionId);
  }, CONVERSATION_TIMEOUT);

  console.log(`Logged message for session ${sessionId}: ${role}: ${message}`);
}

async function sendEmailNotification(sessionId) {
  const conversation = conversations.get(sessionId);
  if (!conversation || conversation.messages.length === 0) {
    console.log(`No conversation to send for session ${sessionId}`);
    return;
  }

  const location = await getLocationFromIP(conversation.ip);
  const endTime = Date.now();
  const duration = (endTime - conversation.startTime) / 1000; // duration in seconds

  const emailContent = `
IP Address: ${conversation.ip}
Location: ${location}
Start Time: ${new Date(conversation.startTime).toLocaleString("en-US", {timeZone: "America/Los_Angeles"})} (California Time)
End Time: ${new Date(endTime).toLocaleString("en-US", {timeZone: "America/Los_Angeles"})} (California Time)
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
    console.log(`Email sent for session ${sessionId}`);
    clearTimeout(conversation.timeoutId);
    conversations.delete(sessionId);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/chat', async (req, res) => {
  const logWithTimestamp = (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`);
  };

  try {
    logWithTimestamp("Received chat request: " + JSON.stringify(req.body));
    const { message, threadId } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    const sessionId = req.session.id;

    let thread;
    if (threadId) {
      thread = await openai.beta.threads.retrieve(threadId);
      logWithTimestamp("Retrieved existing thread: " + thread.id);
    } else {
      thread = await openai.beta.threads.create();
      logWithTimestamp("Created new thread: " + thread.id);
      req.session.threadId = thread.id;
    }

    logConversation(sessionId, message, 'user', ip);

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message
    });
    logWithTimestamp("Added user message to thread");

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    logWithTimestamp("Set response headers for streaming");

    logWithTimestamp("Creating and streaming run...");
    const stream = await openai.beta.threads.runs.createAndStream(thread.id, {
      assistant_id: assistantId
    });
    logWithTimestamp("Stream created");

    let assistantResponse = '';

    stream
      .on('textCreated', (text) => {
        logWithTimestamp("Text created event received");
        res.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`);
        logWithTimestamp("Sent 'start' event to client");
      })
      .on('textDelta', (textDelta, snapshot) => {
        logWithTimestamp(`Text delta event received: ${JSON.stringify(textDelta)}`);
        assistantResponse += textDelta.value;
        res.write(`data: ${JSON.stringify({ type: 'delta', content: textDelta.value })}\n\n`);
        logWithTimestamp(`Sent delta to client: ${textDelta.value}`);
      })
      .on('toolCallCreated', (toolCall) => {
        logWithTimestamp(`Tool call created event received: ${JSON.stringify(toolCall)}`);
        res.write(`data: ${JSON.stringify({ type: 'toolCall', content: toolCall.type })}\n\n`);
        logWithTimestamp("Sent tool call event to client");
      })
      .on('toolCallDelta', (toolCallDelta, snapshot) => {
        logWithTimestamp(`Tool call delta event received: ${JSON.stringify(toolCallDelta)}`);
        if (toolCallDelta.type === 'code_interpreter') {
          if (toolCallDelta.code_interpreter.input) {
            res.write(`data: ${JSON.stringify({ type: 'toolCallDelta', content: toolCallDelta.code_interpreter.input })}\n\n`);
            logWithTimestamp("Sent tool call delta (input) to client");
          }
          if (toolCallDelta.code_interpreter.outputs) {
            toolCallDelta.code_interpreter.outputs.forEach(output => {
              if (output.type === "logs") {
                res.write(`data: ${JSON.stringify({ type: 'toolCallOutput', content: output.logs })}\n\n`);
                logWithTimestamp("Sent tool call output (logs) to client");
              }
            });
          }
        }
      })
      .on('end', async () => {
        logWithTimestamp("Stream ended event received");
        res.write(`data: ${JSON.stringify({ type: 'end', threadId: thread.id })}\n\n`);
        res.end();
        logWithTimestamp("Sent 'end' event to client and ended response");

        logConversation(sessionId, assistantResponse, 'assistant', ip);
        logWithTimestamp("Logged assistant response");
      });

    logWithTimestamp("Waiting for stream to finish...");
    await stream.finalPromise;
    logWithTimestamp("Stream finished");
  } catch (error) {
    logWithTimestamp('Error in /api/chat: ' + error.message);
    res.status(500).json({ error: 'An error occurred while processing your request.' });
  }
});

app.post('/api/reset', async (req, res) => {
  try {
    const threadId = req.session.threadId;
    if (threadId) {
      await openai.beta.threads.del(threadId);
      console.log("Deleted thread:", threadId);
      
      await sendEmailNotification(req.session.id);
    }
    const newThread = await openai.beta.threads.create();
    console.log("Created new thread:", newThread.id);
    req.session.threadId = newThread.id;
    res.json({ message: 'Chat reset successfully', threadId: newThread.id });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while resetting the chat.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));

export default app;
