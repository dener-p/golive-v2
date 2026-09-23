/**
 * Capture quality presets offered by the host page. Sent to the helper as
 * width/height/fps in the `start` command payload; the helper validates them
 * against this exact set and falls back to 1080p30 on anything else.
 */

export interface QualityPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
}

export const DEFAULT_PRESET_ID = '1080p30';

export const QUALITY_PRESETS: QualityPreset[] = [
  { id: '720p30', label: '720p · 30 fps', width: 1280, height: 720, fps: 30 },
  { id: '720p60', label: '720p · 60 fps', width: 1280, height: 720, fps: 60 },
  { id: '1080p30', label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30 },
  { id: '1080p60', label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60 },
  { id: '1440p30', label: '1440p · 30 fps', width: 2560, height: 1440, fps: 30 },
  { id: '4k30', label: '4K · 30 fps', width: 3840, height: 2160, fps: 30 },
  { id: '4k60', label: '4K · 60 fps', width: 3840, height: 2160, fps: 60 },
];

export function presetById(id: string | undefined | null): QualityPreset {
  return (
    QUALITY_PRESETS.find((p) => p.id === id) ??
    QUALITY_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!
  );
}