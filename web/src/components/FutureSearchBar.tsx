import { useRef, useState } from "react";
import { Camera, Mic, Sparkles, Wand2 } from "lucide-react";
import { postJson } from "../api";
import { Button } from "@/components/ui/button";

interface Props {
  rerank: boolean;
  setRerank: (v: boolean) => void;
  send: (text: string, extra?: Record<string, unknown>) => void;
  disabled: boolean;
}

export function FutureSearchBar({ rerank, setRerank, send, disabled }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [listening, setListening] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    const up = await postJson<{ path?: string; error?: string }>("/api/upload", { dataUrl, name: f.name.replace(/\.[^.]+$/, "") });
    if (!up.path) return setNote({ text: `Upload failed: ${up.error}`, bad: true });
    setNote({ text: `${f.name} uploaded` });
    send("Search what you see in my photo: identify the product and find matching items.", { imagePath: up.path });
  };

  const voice = () => {
    if (!SR) return setNote({ text: "Voice needs a browser with the Web Speech API (Chrome or Edge).", bad: true });
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const text = e.results?.[0]?.[0]?.transcript;
      if (text) {
        setNote({ text: `Heard: “${text}”` });
        send(text, { imagePath: null });
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  return (
    <div role="toolbar" aria-label="Future search features" className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
      <Button variant="secondary" disabled={disabled} onClick={() => fileRef.current?.click()}>
        <Camera />
        Search what you see
      </Button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
      <Button variant="secondary" disabled={disabled || listening} onClick={voice} aria-pressed={listening}>
        <Mic className={listening ? "animate-pulse text-bad motion-reduce:animate-none" : undefined} />
        {listening ? "Listening…" : "Voice"}
      </Button>
      <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line px-2.5 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={rerank} onChange={(e) => setRerank(e.target.checked)} />
        <Wand2 className="size-4 text-fg-subtle" aria-hidden />
        Reasoning rerank
      </label>
      <Button variant="highlight" disabled={disabled} onClick={() => send("Build a back-to-school storefront for a 10 year old.", { imagePath: null })}>
        <Sparkles />
        Generative storefront
      </Button>
      {note && (
        <span role="status" className={note.bad ? "text-xs text-bad" : "text-xs text-fg-muted"}>
          {note.text}
        </span>
      )}
    </div>
  );
}
