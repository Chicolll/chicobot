app.post('/api/chat', async (req, res) => {
  const logWithTimestamp = (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`);
  };

  try {
    logWithTimestamp("Received chat request: " + JSON.stringify(req.body));
    const { message, threadId } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    let thread;
    if (threadId) {
      thread = await openai.beta.threads.retrieve(threadId);
      logWithTimestamp("Retrieved existing thread: " + thread.id);
    } else {
      thread = await openai.beta.threads.create();
      logWithTimestamp("Created new thread: " + thread.id);
    }

    // Log user message
    logConversation(thread.id, message, 'user', ip);

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

        // Log assistant response
        logConversation(thread.id, assistantResponse, 'assistant', ip);
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
