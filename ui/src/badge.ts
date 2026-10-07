/** Purpose: Draw the unread-count overlay the desktop shell pins on the app icon (Windows taskbar). */
export function renderBadge(count: number): string | null {
  if (count <= 0) return null;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const label = count > 99 ? "99+" : String(count);
  const radius = size / 2 - 1;
  context.beginPath();
  context.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
  context.fillStyle = "#f6f6f3";
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = "rgba(39, 39, 42, 0.55)";
  context.stroke();
  context.fillStyle = "#2a2a2e";
  context.font = `700 ${label.length > 2 ? 13 : label.length > 1 ? 16 : 19}px "Segoe UI", "Inter", system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, size / 2, size / 2 + 1);
  return canvas.toDataURL("image/png");
}
