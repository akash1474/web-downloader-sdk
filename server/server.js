const http = require("http");
const fs = require("fs");
const path = require("path");

// --- Configuration ---
const FILE_DIR = path.join(__dirname, "public");
const PORT = 3000;
// ---------------------

// Simple MIME type lookup
const mimeTypes = {
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
};

const server = http.createServer((req, res) => {
  // --- 1. CORS Headers (FIXED) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");

  // ✅ THE CRITICAL FIX: Add Accept-Ranges to exposed headers
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Range, Content-Length, Accept-Ranges", // ✅ Added Accept-Ranges
  );

  // Handle pre-flight OPTIONS request
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- 2. Logging ---
  const logPrefix = `[${new Date().toISOString()}]`;
  console.log(`${logPrefix} ${req.method} ${req.url}`);

  if (req.method !== "GET" && req.method !== "HEAD") {
    console.log(`${logPrefix} 405 Method Not Allowed`);
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  // --- 3. File Serving Logic ---
  try {
    // Get the path part of the URL, ignoring query parameters
    const pathOnly = req.url.split("?")[0];

    // Decode the URL path to handle spaces
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathOnly);
    } catch (error) {
      if (error instanceof URIError) {
        console.log(`${logPrefix} 400 Bad Request: Malformed URI`);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: Malformed URI");
        return;
      } else {
        throw error;
      }
    }

    // Sanitize the decoded path to prevent directory traversal
    const sanitizePath = path
      .normalize(decodedPath)
      .replace(/^(\.\.[\/\\])+/, "");
    let filePath = path.join(FILE_DIR, sanitizePath);

    // Security check
    if (!filePath.startsWith(FILE_DIR)) {
      console.log(
        `${logPrefix} 403 Forbidden - Attempted path traversal: ${sanitizePath}`,
      );
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err) {
        if (err.code === "ENOENT") {
          console.log(`${logPrefix} 404 Not Found: ${filePath}`);
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("404 Not Found");
        } else {
          console.error(`${logPrefix} 500 Server Error: ${err.code}`);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`Server Error: ${err.code}`);
        }
        return;
      }

      if (stats.isDirectory()) {
        console.log(
          `${logPrefix} 403 Forbidden - Directory listing not allowed: ${filePath}`,
        );
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: Directory listing is not allowed.");
        return;
      }

      // --- 4. Handle File Serving & Range Requests ---
      const fileSize = stats.size;
      const range = req.headers.range;
      const contentType =
        mimeTypes[path.extname(filePath)] || "application/octet-stream";

      // ✅ Set these headers for ALL responses (including HEAD)
      res.setHeader("Content-Type", contentType);
      res.setHeader("Accept-Ranges", "bytes");

      if (range) {
        // --- PARTIAL CONTENT ---
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize || end >= fileSize || start > end) {
          console.log(`${logPrefix} 416 Range Not Satisfiable: ${range}`);
          res.writeHead(416, {
            "Content-Range": `bytes */${fileSize}`,
            "Content-Type": "text/plain",
          });
          res.end("Range Not Satisfiable");
          return;
        }

        const chunksize = end - start + 1;

        console.log(
          `${logPrefix} 206 Partial Content: ${filePath} (Bytes: ${start}-${end}/${fileSize})`,
        );

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Content-Length": chunksize,
        });

        if (req.method === "GET") {
          const fileStream = fs.createReadStream(filePath, { start, end });

          fileStream.on("error", (streamErr) => {
            console.error(`${logPrefix} Stream Error: ${streamErr.message}`);
            // Can't send headers again, just end the response
            res.end();
          });

          fileStream.pipe(res);
        } else {
          // HEAD request - just send headers
          res.end();
        }
      } else {
        // --- FULL FILE ---
        console.log(
          `${logPrefix} 200 OK: ${filePath} (Full file: ${fileSize} bytes)`,
        );

        res.writeHead(200, {
          "Content-Length": fileSize,
        });

        if (req.method === "GET") {
          const fileStream = fs.createReadStream(filePath);

          fileStream.on("error", (streamErr) => {
            console.error(`${logPrefix} Stream Error: ${streamErr.message}`);
            res.end();
          });

          fileStream.pipe(res);
        } else {
          // HEAD request - just send headers
          res.end();
        }
      }
    });
  } catch (error) {
    // General server error
    console.error(`${logPrefix} 500 Server Error: ${error.message}`);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Server Error: ${error.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}/`);
  console.log(`📁 Serving files from: ${FILE_DIR}`);
  console.log(`✅ Range requests enabled`);
  console.log(`✅ CORS enabled with proper headers`);
});
