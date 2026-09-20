/** A pretend live stream: animated canvas. Useful to test signaling without a real capture source. */
export function createTestVideoStream(fps = 30): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;

  let hue = 0;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const draw = (): void => {
    frame += 1;
    hue = (hue + 1.5) % 360;

    ctx.fillStyle = '#10151d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const t = new Date();
    const stamp = t.toLocaleTimeString();
    ctx.font = 'bold 64px system-ui, sans-serif';
    ctx.fillStyle = `hsl(${hue} 80% 60%)`;
    ctx.textAlign = 'center';
    ctx.fillText('golive test signal', canvas.width / 2, canvas.height / 2 - 40);
    ctx.font = '40px ui-monospace, monospace';
    ctx.fillStyle = '#e6edf3';
    ctx.fillText(`${stamp} · frame ${frame}`, canvas.width / 2, canvas.height / 2 + 30);

    // bouncing orb, to prove motion
    const x = ((frame * 7) % canvas.width) * 1;
    const y = canvas.height / 2 + Math.sin(frame / 18) * 220;
    ctx.beginPath();
    ctx.arc(x, y, 46, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${(hue + 120) % 360} 90% 65%)`;
    ctx.fill();
  };

  draw(); // first frame immediately
  timer = setInterval(draw, 1000 / fps);
  const stream = canvas.captureStream(fps);

  stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (timer) clearInterval(timer);
  });
  return stream;
}

/** Ask the user to share a real screen/window in this browser (test path). */
export async function getDisplayStream(): Promise<MediaStream | null> {
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch {
    return null; // dismissed
  }
}