import { useEffect, useState } from "react";

/**
 * The headline writes itself, co-authored by two cursors, so the page shows what the app
 * does before anyone reads a word. Each person's words keep a highlight in their colour.
 */
const AUTHORS = [
  { name: "Ada", color: "#FF3D8B" },
  { name: "Grace", color: "#3D5AFE" },
];

const SCRIPT: { who: number; text: string }[] = [
  { who: 0, text: "Write it" },
  { who: 1, text: "together," },
  { who: 0, text: "live." },
];

// Words are joined by a space that belongs to nobody, so highlights hug the words.
const TOTAL = SCRIPT.reduce((n, s) => n + s.text.length, 0);

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function Hero() {
  const [typed, setTyped] = useState(() => (prefersReducedMotion() ? TOTAL : 0));

  useEffect(() => {
    if (typed >= TOTAL) return;
    // Pause briefly when the pen passes from one person to the other.
    let pos = 0;
    let atBoundary = false;
    for (const seg of SCRIPT) {
      if (typed === pos && pos > 0) atBoundary = true;
      pos += seg.text.length;
    }
    const delay = typed === 0 ? 500 : atBoundary ? 420 : 75 + Math.random() * 55;
    const t = setTimeout(() => setTyped((n) => n + 1), delay);
    return () => clearTimeout(t);
  }, [typed]);

  // Split the script into what has been typed so far, keeping track of each author's position.
  let remaining = typed;
  const lastSegOf = new Map<number, number>();
  const shown = SCRIPT.map((seg, i) => {
    const n = Math.max(0, Math.min(seg.text.length, remaining));
    remaining -= n;
    if (n > 0) lastSegOf.set(seg.who, i);
    return { ...seg, visible: seg.text.slice(0, n), started: n > 0 };
  });
  const done = typed >= TOTAL;
  const activeSeg = shown.findIndex((s) => s.visible.length < s.text.length);

  return (
    <h1 className="hero-title" aria-label={SCRIPT.map((s) => s.text).join(" ")}>
      <span aria-hidden="true">
        {shown.map((seg, i) => {
          const author = AUTHORS[seg.who]!;
          const showCaret = done ? lastSegOf.get(seg.who) === i : i === activeSeg || (activeSeg === -1 && i === shown.length - 1);
          if (!seg.started && !showCaret) return null;
          // Keep the caret glued to the last word so it never wraps onto a line by itself.
          const cut = seg.visible.lastIndexOf(" ") + 1;
          const head = seg.visible.slice(0, cut);
          const tail = seg.visible.slice(cut);
          return (
            <span key={i}>
              {i > 0 && " "}
              <span className="hero-run" style={{ ["--who" as string]: author.color }}>
                {head && <span className="hero-ink">{head}</span>}
                <span className="hero-nowrap">
                  {tail && <span className="hero-ink">{tail}</span>}
                  {showCaret && (
                    <span className={`hero-caret ${done ? "idle" : ""}`}>
                      <span className="hero-flag">{author.name}</span>
                    </span>
                  )}
                </span>
              </span>
            </span>
          );
        })}
      </span>
    </h1>
  );
}
