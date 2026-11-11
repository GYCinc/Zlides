export interface SavedSlide {
  id: string;
  title: string;
  filename: string;
  html?: string;
  createdAt: number;
  dateStr: string;
}

const STORAGE_KEY = "zlides_saved_worksheets_v1";

export async function fetchSavedSlides(): Promise<SavedSlide[]> {
  try {
    const res = await fetch("/saved");
    if (res.ok) {
      const serverSlides: SavedSlide[] = await res.json();
      return serverSlides;
    }
  } catch (e) {
    console.warn("Could not fetch /saved from server, falling back to localStorage:", e);
  }

  // Fallback to localStorage
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list: SavedSlide[] = JSON.parse(raw);
    return Array.isArray(list) ? list.sort((a, b) => b.createdAt - a.createdAt) : [];
  } catch (e) {
    console.error("Error reading saved slides from localStorage:", e);
    return [];
  }
}

export async function fetchSavedSlideHtml(filename: string): Promise<string> {
  const res = await fetch(`/saved/${encodeURIComponent(filename)}`);
  if (!res.ok) {
    throw new Error(`Failed to load slide (${res.status})`);
  }
  return await res.text();
}

import { normalizeSavedHtml } from "../lib/sse/placeholders.js";

export async function saveSlideToStorage(html: string, promptText: string): Promise<SavedSlide> {
  html = normalizeSavedHtml(html);
  const now = Date.now();
  const d = new Date(now);
  const dateStr = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  let title = promptText.trim().slice(0, 40) || "Untitled Worksheet";
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  if (titleMatch && titleMatch[1].trim()) {
    title = titleMatch[1].trim();
  }

  const cleanName = title.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 30);
  const filename = `slide_${now}_${cleanName}.html`;

  const item: SavedSlide = {
    id: filename,
    title,
    filename,
    html,
    createdAt: now,
    dateStr,
  };

  // 1. Try to save to disk via Vite middleware
  try {
    await fetch("/save-slide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, title }),
    });
  } catch (e) {
    console.warn("Could not save to disk:", e);
  }

  // 2. Also keep in localStorage
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list: SavedSlide[] = raw ? JSON.parse(raw) : [];
    const updated = [item, ...list.filter((s) => s.id !== item.id)].slice(0, 50);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn("Error caching slide in localStorage:", e);
  }

  return item;
}

export function downloadTextFile(text: string, filename: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadHtmlFile(html: string, filename: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".html") ? filename : `${filename}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
