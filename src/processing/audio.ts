// src/processing/audio.ts
import { unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { PassThrough } from 'stream';
import type { R2Service } from '../services/r2.js';

export interface AudioMergeResult {
  audioKey: string;
  audioUrl: string;
  audioDuration: number;
  audioSize: number;
}

export function createAudioMerger(r2Service: R2Service, tempDir: string) {
  async function mergeAndUpload(
    segmentFiles: string[],
    episodeId: string
  ): Promise<AudioMergeResult> {
    const audioKey = `${episodeId}.aac`;
    const concatFilePath = join(tempDir, `${episodeId}_concat.txt`);

    // Create concat file for ffmpeg
    const concatContent = segmentFiles
      .map((f) => `file '${f}'`)
      .join('\n');
    writeFileSync(concatFilePath, concatContent);

    // Calculate total duration by summing all segment durations
    let totalDuration = 0;
    for (const segmentFile of segmentFiles) {
      const segmentDuration = await new Promise<number>((resolve, reject) => {
        ffmpeg.ffprobe(segmentFile, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata.format.duration || 0);
        });
      });
      totalDuration += segmentDuration;
    }

    // Create a stream for ffmpeg output
    const outputStream = new PassThrough();
    let ffmpegError: Error | null = null;

    // Start merge and stream directly to R2
    const ffmpegPromise = new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(concatFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .audioCodec('copy') // No re-encoding needed, just concatenate
        .format('aac')
        .on('end', () => resolve())
        .on('error', (err) => {
          ffmpegError = err;
          outputStream.destroy(err);
          reject(err);
        })
        .pipe(outputStream, { end: true });
    });

    // Upload stream to R2 while ffmpeg is processing
    const uploadPromise = r2Service.uploadStream(audioKey, outputStream, 'audio/aac');

    try {
      // Wait for both to complete
      await Promise.all([ffmpegPromise, uploadPromise]);
      const { url, size } = await uploadPromise;

      // Cleanup concat file
      try {
        unlinkSync(concatFilePath);
      } catch {
        // Ignore cleanup errors
      }

      return {
        audioKey,
        audioUrl: url,
        audioDuration: Math.round(totalDuration),
        audioSize: size,
      };
    } catch (error) {
      // If ffmpeg failed, attempt to clean up partial upload from R2
      if (ffmpegError) {
        try {
          await r2Service.delete(audioKey);
        } catch {
          // Ignore cleanup errors - the partial upload may not exist
        }
      }

      // Cleanup concat file
      try {
        unlinkSync(concatFilePath);
      } catch {
        // Ignore cleanup errors
      }

      // Re-throw the original error
      throw error;
    }
  }

  function cleanupSegments(segmentFiles: string[]): void {
    for (const file of segmentFiles) {
      try {
        unlinkSync(file);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  return {
    mergeAndUpload,
    cleanupSegments,
  };
}
