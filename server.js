import express from 'express';
import OpenAI from 'openai';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import nodemailer from 'nodemailer';

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

// Function to log conversations
async function logConversation(threadId, message, response) {
  const logEntry = `
    Thread ID: ${threadId}
    User: ${message}
    Assistant: ${response}
    Timestamp: ${new Date().toISOString()}
    `;
  
  await fs.appendFile('conversation_log.txt', logEntry);
}

// Function to send email
async function sendEmail(threadId, conversation) {
  let transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  let mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_USER, // Send to yourself
    subject: `Conversation Summary - Thread ${threadId}`,
    text: conversation
  };

  try {
    let info = await transporter.sendMail(mailOptions);
    console.log('Email sent: ' + info.response);
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
    let thread;
    let conversation = '';

    if (threadId) {
      thread = await openai.beta.threads.retrieve(threadId);
      console.log("Retrieved existing thread:", thread.id);
    } else {
      thread = await openai.beta.threads.create();
      console.log("Created new thread:", thread.id);
    }

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message
    });
    console.log("Added user message to thread");

    conversation += `User: ${message}\n`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    let assistantResponse = '';

    const stream = await openai.beta.threads.runs.createAndStream(thread.id, {
      assistant_id: assistantId
    });

    stream
      .on('textCreated', (text) => {
        res.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`);
      })
      .on('textDelta', (textDelta, snapshot) => {
        assistantResponse += textDelta.value;
        res.write(`data: ${JSON.stringify({ type: 'delta', content: textDelta.value })}\n\n`);
      })
      .on('toolCallCreated', (toolCall) => {
        res.write(`data: ${JSON.stringify({ type: 'toolCall', content: toolCall.type })}\n\n`);
      })
      .on('toolCallDelta', (toolCallDelta, snapshot) => {
        if (toolCallDelta.type === 'code_interpreter') {
          if (toolCallDelta.code_interpreter.input) {
            res.write(`data: ${JSON.stringify({ type: 'toolCallDelta', content: toolCallDelta.code_interpreter.input })}\n\n`);
          }
          if (toolCallDelta.code_interpreter.outputs) {
            toolCallDelta.code_interpreter.outputs.forEach(output => {
              if (output.type === "logs") {
                res.write(`data: ${JSON.stringify({ type: 'toolCallOutput', content: output.logs })}\n\n`);
              }
            });
          }
        }
      })
      .on('end', async () => {
        res.write(`data: ${JSON.stringify({ type: 'end', threadId: thread.id })}\n\n`);
        res.end();
        console.log("Stream ended");

        conversation += `Assistant: ${assistantResponse}\n`;

        // Log the conversation
        await logConversation(thread.id, message, assistantResponse);

        // Send email with conversation summary
        await sendEmail(thread.id, conversation);
      });

    await stream.finalPromise;
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while processing your request.' });
  }
});

app.post('/api/reset', async (req, res) => {
  try {
    const { threadId } = req.body;
    if (threadId) {
      await openai.beta.threads.del(threadId);
      console.log("Deleted thread:", threadId);
    }
    const newThread = await openai.beta.threads.create();
    console.log("Created new thread:", newThread.id);
    res.json({ message: 'Chat reset successfully', threadId: newThread.id });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while resetting the chat.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));

export default app;
