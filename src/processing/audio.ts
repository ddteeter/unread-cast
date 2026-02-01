// src/processing/audio.ts
import { createReadStream, unlinkSync, writeFileSync, statSync } from 'fs';
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
    const outputPath = join(tempDir, `${episodeId}_merged.aac`);

    // Create concat file for ffmpeg
    const concatContent = segmentFiles
      .map((f) => `file '${f}'`)
      .join('\n');
    writeFileSync(concatFilePath, concatContent);

    // Merge audio files
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(concatFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .audioCodec('aac')
        .audioBitrate('128k')
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });

    // Get duration using ffprobe
    const duration = await new Promise<number>((resolve, reject) => {
      ffmpeg.ffprobe(outputPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(Math.round(metadata.format.duration || 0));
      });
    });

    // Upload to R2
    const fileBuffer = require('fs').readFileSync(outputPath);
    const { url, size } = await r2Service.upload(audioKey, fileBuffer, 'audio/aac');

    // Cleanup temp files
    try {
      unlinkSync(concatFilePath);
      unlinkSync(outputPath);
    } catch {
      // Ignore cleanup errors
    }

    return {
      audioKey,
      audioUrl: url,
      audioDuration: duration,
      audioSize: size,
    };
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
