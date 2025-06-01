module.exports = async (req, res) => {
  // Handle CORS for all requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests for the main functionality
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get Fireworks API key from environment variables
    const apiKey = process.env.FIREWORKS_API_KEY;
    if (!apiKey) {
      console.error('FIREWORKS_API_KEY environment variable not set');
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'API key not configured. Please check server environment variables.' 
      });
    }

    // Extract the request body
    const { model, messages, temperature, top_p, top_k, max_tokens, presence_penalty, frequency_penalty, stream, tools, tool_choice } = req.body;

    // Validate required fields
    if (!model || !messages) {
      console.error('Missing required fields in request:', { model: !!model, messages: !!messages });
      return res.status(400).json({ 
        error: 'Bad request',
        message: 'Missing required fields: model and messages' 
      });
    }

    // Enhanced logging for Advanced CoD detection
    const hasAdvancedCoD = messages.some(m => 
      m.content?.includes('EMBEDDED REFLECTION') || 
      m.content?.includes('TOKEN-BASED REFLECTION') ||
      m.content?.includes('REFLECTION AFTER') ||
      m.content?.includes('Chain of Draft') ||
      m.content?.includes('~150 tokens') ||
      m.content?.includes('embed reflections immediately')
    );

    console.log('Processing Enhanced CoD request:', { 
      model, 
      messageCount: messages.length, 
      stream: !!stream,
      toolsEnabled: !!(tools && tools.length > 0),
      isEnhancedAdvancedCoD: hasAdvancedCoD,
      lastMessagePreview: messages[messages.length - 1]?.content?.substring(0, 100) + "..."
    });

    // Prepare the request to Fireworks API
    const fireworksPayload = {
      model,
      messages,
      temperature: temperature || 0.6,
      top_p: top_p || 1,
      top_k: top_k || 40,
      max_tokens: max_tokens || 8192,
      presence_penalty: presence_penalty || 0,
      frequency_penalty: frequency_penalty || 0,
      stream: stream || false
    };

    // Add tools if provided
    if (tools && tools.length > 0) {
      fireworksPayload.tools = tools;
      if (tool_choice) {
        fireworksPayload.tool_choice = tool_choice;
      }
    }

    const fireworksHeaders = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };

    // Handle streaming responses
    if (stream) {
      fireworksHeaders['Accept'] = 'text/event-stream';
      
      const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: fireworksHeaders,
        body: JSON.stringify(fireworksPayload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Fireworks API Error:', response.status, errorText);
        return res.status(response.status).json({ 
          error: 'API request failed',
          message: errorText 
        });
      }

      // Set headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (!response.body) {
        return res.status(500).json({ error: 'No response body from API' });
      }

      // Handle streaming with proper async iteration
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        let tokenCount = 0;
        let lastChunkTime = Date.now();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log(`Stream complete. Total tokens processed: ${tokenCount}`);
            break;
          }
          
          const chunk = decoder.decode(value, { stream: true });
          
          // Enhanced logging for Advanced CoD responses
          if (hasAdvancedCoD && chunk.includes('REFLECTION')) {
            const currentTime = Date.now();
            console.log(`CoD Reflection detected in stream at token ~${tokenCount}, time elapsed: ${currentTime - lastChunkTime}ms`);
            lastChunkTime = currentTime;
          }
          
          // Estimate token count (rough approximation: ~4 chars per token)
          tokenCount += Math.ceil(chunk.length / 4);
          
          res.write(chunk);
        }
        res.end();
      } catch (error) {
        console.error('Streaming error:', error);
        res.write(`data: {"error": "Streaming interrupted"}\n\n`);
        res.end();
      }

    } else {
      // Handle non-streaming responses
      const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: fireworksHeaders,
        body: JSON.stringify(fireworksPayload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Fireworks API Error:', response.status, errorText);
        return res.status(response.status).json({ 
          error: 'API request failed',
          message: errorText 
        });
      }

      const data = await response.json();
      
      // Enhanced logging for Advanced CoD responses
      if (hasAdvancedCoD && data.choices?.[0]?.message?.content) {
        const responseContent = data.choices[0].message.content;
        const reflectionCount = (responseContent.match(/\*\*(?:EMBEDDED\s+)?(?:TOKEN-BASED\s+)?REFLECTION/gi) || []).length;
        const metaAnalysisCount = (responseContent.match(/\*\*META[_\s-]*ANALYSIS/gi) || []).length;
        const finalReflectionCount = (responseContent.match(/\*\*FINAL\s+(?:COMPREHENSIVE\s+)?REFLECTION/gi) || []).length;
        
        console.log('Enhanced CoD Response Analysis:', {
          totalTokens: data.usage?.total_tokens || 'unknown',
          completionTokens: data.usage?.completion_tokens || 'unknown',
          embeddedReflections: reflectionCount,
          metaAnalysisBlocks: metaAnalysisCount,
          finalReflections: finalReflectionCount,
          hasProperEmbedding: reflectionCount > 1 // Multiple reflections suggest proper embedding
        });
        
        // Log first 200 chars to verify structure
        console.log('Response structure preview:', responseContent.substring(0, 200) + '...');
      }
      
      return res.status(200).json(data);
    }

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
};
