// src/services/ffmpeg.ts
import { spawn } from 'child_process';
import type { Writable } from 'stream';

export interface FfmpegService {
  getDuration(filePath: string): Promise<number>;
  concatenateToStream(concatFilePath: string, outputStream: Writable): Promise<void>;
}

/**
 * Creates an ffmpeg service that wraps direct CLI calls to ffmpeg/ffprobe.
 * Replaces deprecated fluent-ffmpeg package with direct command execution.
 */
export function createFfmpegService(): FfmpegService {
  /**
   * Get the duration of an audio file using ffprobe.
   */
  async function getDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v',
        'error', // Only show errors
        '-show_entries',
        'format=duration', // Extract duration from format metadata
        '-of',
        'default=noprint_wrappers=1:nokey=1', // Output just the value
        filePath,
      ];

      const ffprobe = spawn('ffprobe', args);
      let output = '';
      let errorOutput = '';

      ffprobe.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });

      ffprobe.stderr.on('data', (data: Buffer) => {
        errorOutput += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed with code ${code}: ${errorOutput}`));
          return;
        }

        const duration = parseFloat(output.trim());
        if (isNaN(duration)) {
          reject(new Error(`Failed to parse duration from ffprobe output: ${output}`));
          return;
        }

        resolve(duration);
      });

      ffprobe.on('error', (err) => {
        reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
      });
    });
  }

  /**
   * Concatenate audio files using ffmpeg's concat demuxer and stream output.
   * The concat file should contain lines like: file '/path/to/segment.aac'
   */
  async function concatenateToStream(
    concatFilePath: string,
    outputStream: Writable
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-f',
        'concat', // Use concat demuxer
        '-safe',
        '0', // Allow absolute paths in concat file
        '-i',
        concatFilePath, // Input concat file
        '-c:a',
        'copy', // Copy audio codec (no re-encoding)
        '-f',
        'adts', // Output format (ADTS is the standard container for AAC audio)
        'pipe:1', // Write to stdout
      ];

      const ffmpeg = spawn('ffmpeg', args);
      let errorOutput = '';

      // Pipe ffmpeg stdout to the output stream
      ffmpeg.stdout.pipe(outputStream, { end: true });

      // Collect stderr for error reporting
      ffmpeg.stderr.on('data', (data: Buffer) => {
        errorOutput += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          const error = new Error(`ffmpeg failed with code ${code}: ${errorOutput}`);
          outputStream.destroy(error);
          reject(error);
          return;
        }
        resolve();
      });

      ffmpeg.on('error', (err) => {
        const error = new Error(`Failed to spawn ffmpeg: ${err.message}`);
        outputStream.destroy(error);
        reject(error);
      });
    });
  }

  return {
    getDuration,
    concatenateToStream,
  };
}
