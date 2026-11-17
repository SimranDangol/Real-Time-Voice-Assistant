"use client";

import { useEffect, useRef } from "react";

interface VisualizerProps {
  state: "idle" | "listening" | "thinking" | "speaking";
  isActive: boolean;
}

export function AudioVisualizer({ state, isActive }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let phase = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const width = canvas.width;
      const height = canvas.height;
      const centerY = height / 2;

      // Determine wave behavior based on state
      let speed = 0.02;
      let amplitude = 8;
      let lines = 3;
      let color = "rgba(148, 163, 184, 0.3)"; // idle slate

      if (!isActive) {
        speed = 0.015;
        amplitude = 4;
        color = "rgba(148, 163, 184, 0.25)";
      } else if (state === "listening") {
        speed = 0.06;
        amplitude = 22;
        lines = 4;
        color = "rgba(16, 185, 129, 0.75)"; // emerald
      } else if (state === "thinking") {
        speed = 0.09;
        amplitude = 12;
        lines = 4;
        color = "rgba(59, 130, 246, 0.75)"; // blue
      } else if (state === "speaking") {
        speed = 0.07;
        amplitude = 30;
        lines = 5;
        color = "rgba(168, 85, 247, 0.85)"; // purple
      }

      phase += speed;

      // Draw multi-layered organic sine waves
      for (let l = 0; l < lines; l++) {
        ctx.beginPath();
        ctx.lineWidth = l === 0 ? 2.5 : 1.5;

        // Gradient line stroke
        const grad = ctx.createLinearGradient(0, 0, width, 0);
        grad.addColorStop(0, "transparent");
        grad.addColorStop(0.2, color);
        grad.addColorStop(0.8, color);
        grad.addColorStop(1, "transparent");
        ctx.strokeStyle = grad;

        const linePhase = phase + l * 0.45;
        const lineAmp = amplitude * (1 - l * 0.18);

        for (let x = 0; x < width; x += 2) {
          // Windowing function to taper edges gracefully
          const windowing = Math.sin((x / width) * Math.PI);
          const y =
            centerY +
            Math.sin(x * 0.02 + linePhase) * lineAmp * windowing +
            Math.cos(x * 0.01 - linePhase * 0.5) * (lineAmp * 0.4) * windowing;

          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [state, isActive]);

  return (
    <div className="relative w-full max-w-sm h-36 flex items-center justify-center">
      <canvas
        ref={canvasRef}
        width={480}
        height={144}
        className="w-full h-full"
      />
    </div>
  );
}
