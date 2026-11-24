/**
 * MAIN World Non-Blocking Network Interceptor
 * Hooks window.fetch, XMLHttpRequest, and WebSocket at document_start without chrome.debugger yellow banner.
 * Supports ChatGPT SSE stream assembly, Bilibili API filtering & 16-byte WS header parsing, and custom regex rules.
 */
(() => {
  if (window.__PACKET_LEDGER_MAIN_ACTIVE__) return;
  window.__PACKET_LEDGER_MAIN_ACTIVE__ = true;

  const EVT_CONFIG_PUSH = '__pl_cfg_push_v1__';
  const EVT_CONFIG_REQ = '__pl_cfg_req_v1__';
  const EVT_PACKET_EMIT = '__pl_pkt_emit_v1__';

  let configReady = false;
  let config = {
    recordingEnabled: true,
    activePreset: 'smart',
    customPattern: '',
    customMatchScope: 'request',
    redactAuth: false,
    maxBodyChars: 512000
  };

  const earlyBuffer = [];
  const MAX_EARLY_BUFFER = 64;

  const STATIC_EXT_RE = /\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|mp4|webm|m4s|mp3|aac|map)(?:\?|$)/i;
  const CHATGPT_NOISE_RE = /(?:ab\.chatgpt\.com|sentry\.io|\/ces\/v1\/|\/_next\/static\/|\/cdn-cgi\/challenge-platform)/i;
  const BILI_NOISE_RE = /(?:data\.bilibili\.com|cm\.bilibili\.com|hdslb\.com|bilivideo\.(?:com|cn)|biliimg\.com|log\/web)/i;
  const BILI_API_ALLOW_RE = /(?:api\.bilibili\.com|api\.live\.bilibili\.com|passport\.bilibili\.com|vc\.bilibili\.com|message\.bilibili\.com|member\.bilibili\.com\/x|search\.bilibili\.com\/api|broadcastlv\.chat\.bilibili\.com)/i;
  const SENSITIVE_HEADER_RE = /^(?:authorization|cookie|set-cookie|x-csrf-token|bili_jct)$/i;

  function resolveAbsoluteUrl(rawUrl) {
    try {
      return new URL(String(rawUrl || ''), window.location.href).href;
    } catch {
      return String(rawUrl || '');
    }
  }

  function detectSiteTag(reqUrl, pageUrl) {
    const combined = `${reqUrl} ${pageUrl}`.toLowerCase();
    if (combined.includes('chatgpt.com') || combined.includes('openai.com') || combined.includes('webpubsub.azure.com')) {
      return 'chatgpt';
    }
    if (combined.includes('bilibili.com') || combined.includes('biliapi')) {
      return 'bilibili';
    }
    try {
      return new URL(pageUrl || reqUrl).hostname || 'other';
    } catch {
      return 'other';
    }
  }

  function matchCustomRule(patternStr, targetStr) {
    if (!patternStr || !patternStr.trim()) return true;
    const trimmed = patternStr.trim();
    if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
      const lastSlash = trimmed.lastIndexOf('/');
      const body = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1) || 'i';
      try {
        return new RegExp(body, flags).test(targetStr);
      } catch {
        return targetStr.toLowerCase().includes(trimmed.toLowerCase());
      }
    }
    return targetStr.toLowerCase().includes(trimmed.toLowerCase());
  }

  function isChatGptMatch(reqUrl, pageUrl) {
    const isCgpt =
      reqUrl.includes('chatgpt.com') ||
      reqUrl.includes('openai.com') ||
      reqUrl.includes('webpubsub.azure.com') ||
      pageUrl.includes('chatgpt.com');
    if (!isCgpt) return false;
    if (STATIC_EXT_RE.test(reqUrl) || CHATGPT_NOISE_RE.test(reqUrl)) return false;
    return (
      reqUrl.includes('/backend-api/') ||
      reqUrl.includes('/backend-anon/') ||
      reqUrl.includes('/public-api/') ||
      reqUrl.startsWith('wss://') ||
      reqUrl.startsWith('ws://')
    );
  }

  function isBilibiliMatch(reqUrl) {
    if (STATIC_EXT_RE.test(reqUrl) || BILI_NOISE_RE.test(reqUrl)) return false;
    return BILI_API_ALLOW_RE.test(reqUrl);
  }

  function shouldCapture(reqUrl, pageUrl, cfg) {
    if (!cfg.recordingEnabled) return false;
    if (!reqUrl || reqUrl.startsWith('data:') || reqUrl.startsWith('blob:') || reqUrl.startsWith('chrome-extension:')) {
      return false;
    }
    switch (cfg.activePreset) {
      case 'chatgpt':
        return isChatGptMatch(reqUrl, pageUrl);
      case 'bilibili':
        return isBilibiliMatch(reqUrl);
      case 'smart':
        return isChatGptMatch(reqUrl, pageUrl) || isBilibiliMatch(reqUrl);
      case 'custom': {
        if (STATIC_EXT_RE.test(reqUrl)) return false;
        const candidate = cfg.customMatchScope === 'page' ? pageUrl : reqUrl;
        return matchCustomRule(cfg.customPattern, candidate);
      }
      case 'all_api':
      default:
        return !STATIC_EXT_RE.test(reqUrl) && !CHATGPT_NOISE_RE.test(reqUrl) && !BILI_NOISE_RE.test(reqUrl);
    }
  }

  function sanitizeHeaders(headersObj, redact) {
    if (!headersObj || typeof headersObj !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(headersObj)) {
      const strVal = String(v ?? '');
      if (redact && SENSITIVE_HEADER_RE.test(k)) {
        out[k] = `[REDACTED len=${strVal.length}]`;
      } else {
        out[k] = strVal;
      }
    }
    return out;
  }

  function clampText(str, maxLen) {
    if (typeof str !== 'string') return str;
    if (str.length <= maxLen) return str;
    return `${str.slice(0, maxLen)}\n...[TRUNCATED total=${str.length} chars]`;
  }

  function uint8ToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /**
   * Extract readable assistant text and user prompt summary for ChatGPT SSE streams
   */
  function parseChatGptSse(rawBody) {
    if (typeof rawBody !== 'string' || !rawBody.includes('data:')) return null;
    const lines = rawBody.split(/\r?\n/);
    let eventCount = 0;
    const chunks = [];
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      eventCount += 1;
      try {
        const obj = JSON.parse(dataStr);
        if (typeof obj.v === 'string' && (!obj.p || obj.p.endsWith('/parts/0'))) {
          chunks.push(obj.v);
        } else if (Array.isArray(obj.v)) {
          for (const op of obj.v) {
            if (op && op.o === 'append' && typeof op.v === 'string' && String(op.p || '').includes('/parts/')) {
              chunks.push(op.v);
            }
          }
        } else if (obj.message?.author?.role === 'assistant' && Array.isArray(obj.message?.content?.parts)) {
          const part = obj.message.content.parts.join('');
          if (part && chunks.length === 0) chunks.push(part);
        }
      } catch {
        // Ignore non-JSON SSE lines
      }
    }
    return {
      sseEventCount: eventCount,
      extractedText: chunks.length > 0 ? chunks.join('') : undefined
    };
  }

  function extractPromptPreview(reqBody) {
    if (typeof reqBody !== 'string' || !reqBody.startsWith('{')) return undefined;
    try {
      const parsed = JSON.parse(reqBody);
      if (Array.isArray(parsed.messages)) {
        const lastMsg = parsed.messages[parsed.messages.length - 1];
        const parts = lastMsg?.content?.parts;
        if (Array.isArray(parts)) return parts.filter((p) => typeof p === 'string').join('\n').slice(0, 300);
      }
    } catch {
      // Not a ChatGPT conversation payload
    }
    return undefined;
  }

  /**
   * Parse Bilibili Live 16-byte WebSocket Binary Packet Header
   */
  async function parseBiliWsBinary(uint8) {
    if (uint8.byteLength < 16) {
      return { rawBase64: uint8ToBase64(uint8), byteLength: uint8.byteLength };
    }
    const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
    const packetLen = view.getUint32(0, false);
    const headerLen = view.getUint16(4, false);
    const protoVer = view.getUint16(6, false);
    const op = view.getUint32(8, false);
    const seq = view.getUint32(12, false);

    if (headerLen !== 16 || packetLen > uint8.byteLength + 4096) {
      return { rawBase64: uint8ToBase64(uint8.subarray(0, 4096)), byteLength: uint8.byteLength };
    }

    const body = uint8.subarray(16);
    const meta = {
      biliHeader: { packetLen, headerLen, protoVer, op, seq },
      byteLength: uint8.byteLength
    };

    if ((protoVer === 0 || op === 8 || op === 7) && body.byteLength > 0) {
      meta.decodedText = new TextDecoder().decode(body);
    } else if (op === 3 && body.byteLength >= 4) {
      meta.popularity = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, false);
    } else if (protoVer === 2 && typeof DecompressionStream === 'function') {
      try {
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(body);
        writer.close();
        const decompressed = new Uint8Array(await new Response(ds.readable).arrayBuffer());
        meta.decodedMessages = splitBiliSubpackets(decompressed);
      } catch {
        meta.rawBase64 = uint8ToBase64(uint8);
      }
    } else {
      // protoVer === 3 (Brotli): store Base64 so local-sink.mjs can auto-decompress via Node zlib.brotliDecompressSync
      meta.rawBase64 = uint8ToBase64(uint8);
    }
    return meta;
  }

  function splitBiliSubpackets(buf) {
    const msgs = [];
    let offset = 0;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    while (offset + 16 <= buf.byteLength) {
      const pktLen = view.getUint32(offset, false);
      const hdrLen = view.getUint16(offset + 4, false);
      if (pktLen < 16 || offset + pktLen > buf.byteLength) break;
      const subBody = buf.subarray(offset + hdrLen, offset + pktLen);
      try {
        msgs.push(JSON.parse(new TextDecoder().decode(subBody)));
      } catch {
        msgs.push(new TextDecoder().decode(subBody));
      }
      offset += pktLen;
    }
    return msgs;
  }

  function finalizeAndDispatch(rawRecord) {
    if (!configReady) {
      if (earlyBuffer.length < MAX_EARLY_BUFFER) {
        earlyBuffer.push(rawRecord);
      }
      return;
    }
    if (!shouldCapture(rawRecord.url, rawRecord.pageUrl, config)) return;

    const record = {
      ...rawRecord,
      siteTag: detectSiteTag(rawRecord.url, rawRecord.pageUrl),
      requestHeaders: sanitizeHeaders(rawRecord.requestHeaders, config.redactAuth),
      responseHeaders: sanitizeHeaders(rawRecord.responseHeaders, config.redactAuth),
      requestBody: clampText(rawRecord.requestBody, config.maxBodyChars),
      responseBody: clampText(rawRecord.responseBody, config.maxBodyChars)
    };

    window.dispatchEvent(
      new CustomEvent(EVT_PACKET_EMIT, {
        detail: JSON.stringify(record)
      })
    );
  }

  window.addEventListener(EVT_CONFIG_PUSH, (event) => {
    if (typeof event.detail !== 'string') return;
    try {
      config = { ...config, ...JSON.parse(event.detail) };
      if (!configReady) {
        configReady = true;
        while (earlyBuffer.length > 0) {
          finalizeAndDispatch(earlyBuffer.shift());
        }
      }
    } catch {
      // Ignore invalid config payload
    }
  });

  window.dispatchEvent(new CustomEvent(EVT_CONFIG_REQ));

  // ============================================================================
  // 1. Hook window.fetch (Non-blocking clone + stream reader for SSE & JSON)
  // ============================================================================
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = async function patchedFetch(input, init) {
      const pageUrl = window.location.href;
      let reqUrl = '';
      let method = 'GET';
      const reqHeaders = {};
      let reqBody = null;

      try {
        if (input instanceof Request) {
          reqUrl = input.url;
          method = input.method || 'GET';
          input.headers.forEach((v, k) => {
            reqHeaders[k] = v;
          });
        } else {
          reqUrl = resolveAbsoluteUrl(input);
        }
        if (init) {
          if (init.method) method = String(init.method).toUpperCase();
          if (init.headers) {
            new Headers(init.headers).forEach((v, k) => {
              reqHeaders[k] = v;
            });
          }
          if (typeof init.body === 'string') {
            reqBody = init.body;
          } else if (init.body instanceof URLSearchParams) {
            reqBody = init.body.toString();
          } else if (init.body instanceof FormData) {
            const entries = [];
            init.body.forEach((v, k) => {
              entries.push(`${k}=${v instanceof File ? `[File:${v.name}]` : String(v)}`);
            });
            reqBody = entries.join('&');
          } else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
            const u8 = init.body instanceof ArrayBuffer
              ? new Uint8Array(init.body)
              : new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength);
            reqBody = `[binary body ${u8.byteLength} bytes]`;
          }
        } else if (input instanceof Request && input.body && !input.bodyUsed && method !== 'GET' && method !== 'HEAD') {
          try {
            reqBody = await input.clone().text();
          } catch {
            // Request stream cannot be cloned
          }
        }
      } catch {
        // Never break caller's fetch setup
      }

      const candidatePrecheck = !configReady
        ? !STATIC_EXT_RE.test(reqUrl)
        : shouldCapture(reqUrl, pageUrl, config);

      if (!candidatePrecheck) {
        return nativeFetch.apply(this, arguments);
      }

      const startedAt = performance.now();
      const capturedAt = new Date().toISOString();

      try {
        const response = await nativeFetch.apply(this, arguments);
        const resHeaders = {};
        response.headers.forEach((v, k) => {
          resHeaders[k] = v;
        });
        const contentType = (response.headers.get('content-type') || '').toLowerCase();

        // Clone asynchronously without delaying the caller's Response or SSE typewriter stream
        (async () => {
          let responseBody = null;
          let partialStream = false;
          let sseSummary = null;
          try {
            const cloned = response.clone();
            if (contentType.includes('event-stream') && cloned.body) {
              const reader = cloned.body.getReader();
              const decoder = new TextDecoder();
              const parts = [];
              let totalLen = 0;
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const chunkText = decoder.decode(value, { stream: true });
                  if (totalLen < config.maxBodyChars) {
                    parts.push(chunkText);
                    totalLen += chunkText.length;
                  }
                }
                parts.push(decoder.decode());
              } catch {
                partialStream = true;
              }
              responseBody = parts.join('');
              sseSummary = parseChatGptSse(responseBody);
            } else if (
              contentType.includes('octet-stream') ||
              contentType.includes('protobuf') ||
              reqUrl.includes('/seg.so')
            ) {
              const buf = new Uint8Array(await cloned.arrayBuffer());
              responseBody = `[base64 protobuf/binary ${buf.byteLength} bytes] ${uint8ToBase64(buf.subarray(0, 65536))}`;
            } else if (
              contentType.includes('json') ||
              contentType.includes('text/') ||
              contentType.includes('xml') ||
              contentType.includes('javascript') ||
              contentType === ''
            ) {
              responseBody = await cloned.text();
            } else {
              const buf = await cloned.arrayBuffer();
              responseBody = `[binary ${contentType}, ${buf.byteLength} bytes]`;
            }
          } catch (readErr) {
            responseBody = `[body read interrupted: ${readErr?.message || 'aborted'}]`;
            partialStream = true;
          }

          finalizeAndDispatch({
            transport: 'fetch',
            capturedAt,
            pageUrl,
            pageTitle: document.title || '',
            url: reqUrl,
            method,
            status: response.status,
            statusText: response.statusText,
            mimeType: contentType,
            durationMs: Math.round(performance.now() - startedAt),
            partialStream,
            promptPreview: extractPromptPreview(reqBody),
            sseSummary,
            requestHeaders: reqHeaders,
            requestBody: reqBody,
            responseHeaders: resHeaders,
            responseBody
          });
        })();

        return response;
      } catch (err) {
        finalizeAndDispatch({
          transport: 'fetch',
          capturedAt,
          pageUrl,
          pageTitle: document.title || '',
          url: reqUrl,
          method,
          status: 0,
          statusText: err?.name || 'NetworkError',
          failed: true,
          errorText: err?.message || String(err),
          durationMs: Math.round(performance.now() - startedAt),
          promptPreview: extractPromptPreview(reqBody),
          requestHeaders: reqHeaders,
          requestBody: reqBody,
          responseHeaders: {},
          responseBody: null
        });
        throw err;
      }
    };
  }

  // ============================================================================
  // 2. Hook XMLHttpRequest (Covers Bilibili legacy & passport/upload XHR APIs)
  // ============================================================================
  const XHRProto = XMLHttpRequest.prototype;
  const nativeOpen = XHRProto.open;
  const nativeSetHeader = XHRProto.setRequestHeader;
  const nativeSend = XHRProto.send;

  XHRProto.open = function patchedOpen(method, url) {
    this.__plMeta = {
      method: String(method || 'GET').toUpperCase(),
      url: resolveAbsoluteUrl(url),
      reqHeaders: {}
    };
    return nativeOpen.apply(this, arguments);
  };

  XHRProto.setRequestHeader = function patchedSetHeader(name, value) {
    if (this.__plMeta) {
      this.__plMeta.reqHeaders[name] = value;
    }
    return nativeSetHeader.apply(this, arguments);
  };

  XHRProto.send = function patchedSend(body) {
    const meta = this.__plMeta;
    const pageUrl = window.location.href;
    if (meta) {
      const shouldTrack = !configReady
        ? !STATIC_EXT_RE.test(meta.url)
        : shouldCapture(meta.url, pageUrl, config);

      if (shouldTrack) {
        const startedAt = performance.now();
        const capturedAt = new Date().toISOString();
        let reqBody = null;
        if (typeof body === 'string') {
          reqBody = body;
        } else if (body instanceof URLSearchParams) {
          reqBody = body.toString();
        } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
          const len = body instanceof ArrayBuffer ? body.byteLength : body.byteLength;
          reqBody = `[binary XHR body ${len} bytes]`;
        }

        this.addEventListener(
          'loadend',
          () => {
            const resHeaders = {};
            const rawHeaders = this.getAllResponseHeaders() || '';
            for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
              const idx = line.indexOf(':');
              if (idx > 0) {
                resHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
              }
            }
            const contentType = (resHeaders['content-type'] || '').toLowerCase();
            let responseBody = null;
            try {
              if (this.responseType === '' || this.responseType === 'text') {
                responseBody = this.responseText;
              } else if (this.responseType === 'json') {
                responseBody = JSON.stringify(this.response);
              } else if (this.responseType === 'arraybuffer' && this.response instanceof ArrayBuffer) {
                const u8 = new Uint8Array(this.response);
                responseBody = `[base64 binary ${u8.byteLength} bytes] ${uint8ToBase64(u8.subarray(0, 65536))}`;
              } else if (this.response instanceof Blob) {
                responseBody = `[Blob ${this.response.type || contentType}, ${this.response.size} bytes]`;
              }
            } catch (err) {
              responseBody = `[XHR response unreadable: ${err?.message}]`;
            }

            finalizeAndDispatch({
              transport: 'xhr',
              capturedAt,
              pageUrl,
              pageTitle: document.title || '',
              url: meta.url,
              method: meta.method,
              status: this.status,
              statusText: this.statusText,
              mimeType: contentType,
              durationMs: Math.round(performance.now() - startedAt),
              requestHeaders: meta.reqHeaders,
              requestBody: reqBody,
              responseHeaders: resHeaders,
              responseBody
            });
          },
          { once: true }
        );
      }
    }
    return nativeSend.apply(this, arguments);
  };

  // ============================================================================
  // 3. Hook WebSocket (Covers ChatGPT wss:// push & Bilibili Live 16B packets)
  // ============================================================================
  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args, newTarget) {
        const wsInstance = Reflect.construct(Target, args, newTarget);
        const wsUrl = resolveAbsoluteUrl(args[0]);
        const pageUrl = window.location.href;

        const trackCandidate = !configReady ? true : shouldCapture(wsUrl, pageUrl, config);
        if (!trackCandidate) return wsInstance;

        const isBiliLiveWs = wsUrl.includes('broadcastlv.chat.bilibili.com');

        const nativeWsSend = wsInstance.send;
        wsInstance.send = function patchedWsSend(data) {
          (async () => {
            let payloadDesc = null;
            if (typeof data === 'string') {
              payloadDesc = data;
            } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
              const u8 = data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
              payloadDesc = isBiliLiveWs
                ? JSON.stringify(await parseBiliWsBinary(u8))
                : `[binary frame ${u8.byteLength} bytes]`;
            }
            finalizeAndDispatch({
              transport: 'websocket',
              direction: 'sent',
              capturedAt: new Date().toISOString(),
              pageUrl,
              pageTitle: document.title || '',
              url: wsUrl,
              method: 'WS_SEND',
              status: 101,
              mimeType: 'websocket/frame',
              requestHeaders: {},
              requestBody: payloadDesc,
              responseHeaders: {},
              responseBody: null
            });
          })();
          return nativeWsSend.apply(this, arguments);
        };

        wsInstance.addEventListener('message', async (evt) => {
          try {
            let responseBody = null;
            let wsMeta = undefined;
            if (typeof evt.data === 'string') {
              responseBody = evt.data;
            } else if (evt.data instanceof ArrayBuffer) {
              const u8 = new Uint8Array(evt.data);
              if (isBiliLiveWs) {
                wsMeta = await parseBiliWsBinary(u8);
                responseBody = JSON.stringify(wsMeta);
              } else {
                responseBody = `[binary frame ${u8.byteLength} bytes] ${uint8ToBase64(u8.subarray(0, 16384))}`;
              }
            } else if (evt.data instanceof Blob) {
              const u8 = new Uint8Array(await evt.data.arrayBuffer());
              if (isBiliLiveWs) {
                wsMeta = await parseBiliWsBinary(u8);
                responseBody = JSON.stringify(wsMeta);
              } else {
                responseBody = `[Blob frame ${u8.byteLength} bytes] ${uint8ToBase64(u8.subarray(0, 16384))}`;
              }
            }

            // Skip noisy Bilibili heartbeat replies (op=3) unless user chose custom/all_api
            if (wsMeta?.biliHeader?.op === 3 && config.activePreset !== 'all_api') return;

            finalizeAndDispatch({
              transport: 'websocket',
              direction: 'received',
              capturedAt: new Date().toISOString(),
              pageUrl,
              pageTitle: document.title || '',
              url: wsUrl,
              method: 'WS_RECV',
              status: 101,
              mimeType: 'websocket/frame',
              wsMeta,
              requestHeaders: {},
              requestBody: null,
              responseHeaders: {},
              responseBody
            });
          } catch {
            // Never disrupt page WebSocket listeners
          }
        });

        return wsInstance;
      }
    });
  }
})();
