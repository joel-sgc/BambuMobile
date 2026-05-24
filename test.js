import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Define the API endpoint (Change port/IP if needed)
const API_URL = 'http://100.113.187.13:9090/api/slice';

// Replace this with a real MakerWorld .3mf download link for testing
const MAKERWORLD_URL =
  'https://makerworld.bblmw.com/makerworld/model/US73b81d0d06e37b/441558349/instance/2bf2f11a-a152-46cd-8ae6-9c701c9ce616.3mf?at=1779593303&exp=1779593603&key=c49712b88e3f9ecb122bb6848001bd3c&uid=1671159018';

async function requestSlice() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outputPath = path.join(__dirname, 'downloaded_print.gcode.3mf');

  console.log(`Sending slicing request to ${API_URL}...`);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: MAKERWORLD_URL }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Server returned error (${response.status}): ${errorText}`,
      );
    }

    console.log('Slicing successful! Downloading compiled binary stream...');

    // Open a writable stream to the output path
    const fileStream = fs.createWriteStream(outputPath);

    // Node's native fetch response.body is a ReadableStream
    const reader = response.body.getReader();

    // Helper function to read the stream chunks sequentially
    async function streamData() {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
      }
      fileStream.end();
      console.log(`Success! File compiled and saved to:\n--> ${outputPath}`);
    }

    await streamData();
  } catch (error) {
    console.error('Failed to get sliced file:', error.message);
  }
}

requestSlice();
