export async function getJson<T = any>(url: string): Promise<T> {
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok && !data) throw new Error(`${r.status} ${url}`);
  return data as T;
}

export async function postJson<T = any>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json().catch(() => ({ error: `${r.status}` }))) as T;
}

export const EMOJI: [RegExp, string][] = [
  [/tortilla|taco/i, "🌮"], [/beef/i, "🥩"], [/cheese/i, "🧀"], [/salsa/i, "🍅"], [/season/i, "🧂"], [/egg/i, "🥚"],
  [/banana/i, "🍌"], [/apple/i, "🍎"], [/milk/i, "🥛"], [/bar/i, "🍫"], [/lunch/i, "🍱"], [/earbud/i, "🎧"], [/charger|cable/i, "🔌"],
  [/pasta/i, "🍝"], [/cracker/i, "🍘"], [/diaper/i, "🧷"],
];
export const emojiFor = (title: string) => EMOJI.find(([re]) => re.test(title))?.[1] ?? "🛒";
