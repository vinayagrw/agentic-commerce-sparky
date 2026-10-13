# Falsification spike — result

**Run:** 2026-09-16, phase 2. **Against:** `spike/preregistration.md`, unedited.
**Claim under test:** *A calibrated LLM judge, run through the Claude Code CLI in headless mode, agrees with human graded relevance judgements well enough to carry the bulk of relevance labelling.*

---

## 1. Verdict

# PASS

| Preregistered condition (§3) | Required | Measured | Met |
|---|---|---|---|
| 1. Point estimate, unweighted Cohen's κ | ≥ 0.40 | **0.4901** | yes |
| 2. Lower bound of 95% cluster-bootstrap CI (10,000 replicates, percentile, 60 query clusters) | > 0.30 | **0.3796** | yes |
| Parsed labels (else INCONCLUSIVE) | ≥ 500 of 600 | **600 of 600** | yes |

**Unweighted Cohen's κ = 0.4901, 95% cluster-bootstrap CI [0.3796, 0.5958], n = 600 pairs in 60 query clusters, observed agreement p_o = 0.7167.** [measured: judge vs ESCI human labels, n=600]

Both preregistered conditions are met, so the verdict is PASS. It is a pass near the floor: the point estimate sits 0.09 above the threshold, the interval's lower bound sits 0.08 above its threshold, and 5.5% of bootstrap replicates fall below the 0.40 point-estimate threshold. κ = 0.49 is the low end of the conventional "moderate agreement" band, not the middle of it.

Three findings below qualify what the pass means and none of them can change the verdict, because §4.4 pre-committed that secondary measures cannot overturn a primary result:

- **The judge agrees with itself far more than it agrees with humans** — judge–judge κ = 0.940 against judge–human κ = 0.490 [measured: 150 pairs re-run, §6]. This is the Fröbe pattern the preregistration named as the sceptical evidence, observed directly. It does *not* trigger branch F4, which required self-consistency to be *poor*.
- **Preregistered system ordering was not preserved** (secondary 3) — but no ordering was statistically resolved under *either* label source, so this measure turned out to be under-powered rather than informative. Detail and consequences in §5.3.
- **The judge is near-blind on the Irrelevant class**: recall 0.146, F1 0.179 [measured: 41 human-I pairs]. Most human-I items are labelled S by the judge.

The contamination probe is clean (§5.5) and the self-consistency probe is strong, so neither branch F3 nor branch F4 fires. Branches F1 and F2 are conditioned on a κ failure and do not apply.

**Total Claude spend: $2.41 measured** ($2.1966 for the 85 preregistered calls, plus ≈$0.21 for four pilot calls that validated the CLI flags). **Wall clock for the judge loop: 3.1 minutes.** Both inside the US$3 / 45-minute limits; no preregistered stop rule fired.

---

## 2. Deviations from the preregistration

Every departure, including the ones supplied as environment facts. Nothing else was changed.

1. **`--bare` replaced.** There is no `ANTHROPIC_API_KEY` on this machine and `--bare` restricts Anthropic auth to `ANTHROPIC_API_KEY` or `apiKeyHelper`, so it cannot authenticate here. The supplied equivalent isolation was used instead: `--setting-sources "" --strict-mcp-config --mcp-config .mcp-empty.json --disable-slash-commands --no-session-persistence --tools ""`. This blocks the same things `--bare` blocks for this run's purposes — no user/project settings, no MCP server, no skills or slash commands, no session state carried between calls, and no tools at all.
2. **`--system-prompt-file` does not exist in the installed CLI** (Claude Code 2.1.246). Replaced with `--system-prompt "<contents of rubric_full.md>"`, which is the same content by a different transport.
3. **`--permission-prompts none` does not exist in the installed CLI.** Omitted. `--permission-mode dontAsk` was used as preregistered, and `--tools ""` removes every tool, so there is nothing left that could raise a prompt.
4. **The `system/init` model string was not available.** `--output-format json` returns a single result object rather than the event stream that carries `system/init`. The model was read from that object's `modelUsage` key instead: **`claude-opus-5[1m]`**, identical across all 85 calls. This is the CLI's default model, not a choice made after the pilot; the preregistration's intent (no model shopping) is preserved.
5. **The 8 in-context examples were placed in the system prompt with the rubric**, not in the per-call user prompt. This follows §4.2's literal command, where `-p` carries `"<query + 10 candidates>"` and the rubric file carries everything else. `rubric.md` is the rubric alone; `rubric_full.md` is `rubric.md` plus the 8 examples and is the file that was passed. Side effect: the shared prefix is prompt-cached, which cut cost roughly in half.
6. **`CLAUDE_CODE_PROMPT_CACHE_TTL=5m` was set** for the judge loop (default is 1h). A 1-hour cache write is billed at a higher multiple than a 5-minute one, and the whole loop runs in 3 minutes. This changes cost only; prompt content, model and sampling are untouched. Without it the pilot measured $0.058/call, which would have exhausted the budget partway through block A and forced an INCONCLUSIVE verdict on n < 500.
7. **Pilot spend.** Four smoke calls (≈$0.21) were made before the loop to verify the flags and measure per-call cost. They used sample queries but their labels are not used in any result. They count against the external US$3 limit but not against §6's cumulative counters, which are defined on the judge loop. A guard was added that stops the loop if loop spend + pilot exceeds $2.85 — conservative relative to the preregistered $2.80 hard stop, and it never fired.
8. **Which queries went into blocks B and C.** The preregistration fixed the counts (10 and 15) but not the selection. The first 10 and first 15 query_ids in ascending order were used — deterministic, and fixed in code before the blocks ran.
9. **Secondary measure 3 gained a paired bootstrap** over the 60 queries on each pairwise NDCG@5 delta. This was not preregistered. It is reported because without it the preregistered "same order / same signs" test would be reported as if it meant something, when in fact none of the three systems is distinguishable from the others at n = 60 under either label source. It is non-gating and the verdict was already determined by §3.

---

## 3. What was run

**Data.** `data/shopping_queries_dataset_examples.parquet` (2,621,288 rows) joined to `data/shopping_queries_dataset_products.parquet` on `(product_id, product_locale)`.

**Sampling** (`sample.py`, `random_seed = 20260916`), exactly as §4.1:
- Eligibility `product_locale == "us" AND large_version == 1 AND split == "test"` → 425,762 rows.
- Query_ids with ≥ 10 judged products → 22,330.
- 60 query_ids drawn without replacement; 10 products drawn without replacement per query → **600 pairs in 60 clusters of 10**.
- Product text: title, brand, colour, bullet points, description, whitespace-normalised, truncated to 500 characters. 0 of 600 were empty.

**Realised label marginals of the sample** [measured: n=600]: E 385 (64.2%), S 158 (26.3%), I 41 (6.8%), C 16 (2.7%). Unstratified, as preregistered — this is the natural ESCI rate, and it is why C and I carry wide intervals.

**In-context examples**: 8 from `split == "train"`, US locale, 2 per class, same seed. Reproduced verbatim in Appendix A.

**The judge call**, one per query, 10 candidates each:

```
claude -p "<query + 10 candidates>" \
  --setting-sources "" --strict-mcp-config --mcp-config .mcp-empty.json \
  --disable-slash-commands --no-session-persistence --tools "" \
  --system-prompt "<rubric_full.md>" \
  --output-format json \
  --json-schema '{"type":"object","properties":{"labels":{"type":"array",
     "items":{"type":"object","properties":{"product_id":{"type":"string"},
     "label":{"enum":["E","S","C","I"]}},"required":["product_id","label"]}}},
     "required":["labels"]}' \
  --permission-mode dontAsk
```

Concurrency 4. No `system/api_retry` events and no rate-limit errors, so the fallback to concurrency 2 was not needed.

**Execution order and outcome** (§6): A (60 calls, $1.7712, 2.1 min) → B (10 calls, $0.1669) → C (15 calls, $0.2585). Spend at the end of block A was $1.77, below the $2.00 threshold, so block C ran as preregistered. **0 retries, 0 failed calls, 0 schema violations, 0 missing or extra product_ids.** The preregistered rule that unlabelled pairs count as disagreements therefore had nothing to act on.

---

## 4. Primary result in detail

[measured: n=600 pairs, 60 clusters, judge `claude-opus-5[1m]`]

- Observed agreement p_o = **0.7167** (430 of 600 pairs).
- Chance agreement p_e = **0.4444** (implied by κ and p_o; the sample's 64% Exact rate is what makes p_e this high).
- **Unweighted Cohen's κ = 0.4901.**
- Cluster bootstrap, 10,000 replicates resampling the 60 query clusters with replacement: mean 0.4885, SD **0.0552**, percentile 95% CI **[0.3796, 0.5958]**.
- 94.5% of replicates ≥ 0.40; 99.96% > 0.30.

The preregistration predicted SE ≈ 0.050 from an assumed p_o = 0.65, p_e = 0.35 and ρ = 0.2. The realised SE is 0.0552 — the power arithmetic in §4.3 was close, and the sample size did what it was sized to do: separate moderate agreement from weak agreement. As §4.3 stated in advance, it cannot separate κ = 0.45 from κ = 0.55, and no claim here does.

**Bootstrap distribution** (10,000 replicates, saved to `bootstrap.npy`):

```
 [0.259,0.294)                                                       4
 [0.294,0.329)                                                      17
 [0.329,0.365)  #                                                  101
 [0.365,0.400)  ########                                           427
 [0.400,0.435)  #####################                             1114
 [0.435,0.470)  ########################################          2045
 [0.470,0.506)  ##################################################2553
 [0.506,0.541)  #######################################           2013
 [0.541,0.576)  ######################                            1159
 [0.576,0.612)  ########                                           450
 [0.612,0.647)  ##                                                 105
 [0.647,0.682)                                                      12
```

percentiles: 0.5% 0.346 · 2.5% 0.380 · 25% 0.451 · 50% 0.489 · 75% 0.526 · 97.5% 0.596 · 99.5% 0.626

---

## 5. Secondary measures

All six were preregistered in §4.4 as non-gating. All six are reported.

### 5.1 Weighted κ (KDD Cup 2022 task-1 gains E=1.0, S=0.1, C=0.01, I=0.0)

**κ_w = 0.5959, 95% cluster-bootstrap CI [0.4807, 0.6994]** [measured: n=600]. Weights are `|gain_i − gain_j|`. Higher than unweighted κ because the judge's dominant error — calling human-E items S — is cheap under the gain mapping, and because everything that is not E collapses toward a gain of ~0. This is exactly why §2 made the unweighted figure primary; the weighted figure flatters the judge and is not the number the Tier 1 gate would use.

### 5.2 Confusion matrix and per-class performance

Rows = ESCI human label, columns = judge label [measured: n=600]:

```
           E     S     C     I   total
   E     293    83     4     5     385
   S      22   117     5    14     158
   C       0     1    14     1      16
   I       3    27     5     6      41
 total   318   228    28    26     600
```

| class | n human | n judge | precision | recall | F1 | 95% CI on F1 |
|---|---|---|---|---|---|---|
| E | 385 | 318 | 0.921 | 0.761 | 0.834 | [0.772, 0.884] |
| S | 158 | 228 | 0.513 | 0.741 | 0.606 | [0.492, 0.708] |
| C | 16 | 28 | 0.500 | 0.875 | 0.636 | [0.323, 0.813] |
| I | 41 | 26 | 0.231 | 0.146 | 0.179 | [0.034, 0.348] |

Three things this shows, all of which matter more to the design than κ does:

1. **The judge is systematically harsher than the humans on Exact.** 83 of 385 human-E pairs (22%) were called S. Precision on E is high (0.921), so when the judge says Exact it is almost always right; it simply says Exact less often than the humans do.
2. **Irrelevant is the failure.** Of 41 human-I pairs the judge caught 6. It called 27 of them S. A judge that cannot recognise irrelevance is precisely the wrong judge for a *top-k irrelevant rate* metric, which §5.1 of the design lists as a Tier 1 metric. The intervals here are wide (41 pairs), but the direction is not in doubt.
3. **Errors are concentrated on one boundary rather than scattered.** 105 of the 170 disagreements sit on the E↔S boundary (83 human-E called S, 22 human-S called E). That is the correctable kind of error the preregistration's threshold rationale assumed — a disagreement queue seeded by judge-S-on-likely-E would catch most of it — and it is the main reason to read this pass as genuine rather than lucky.

### 5.3 System-ordering preservation — the preregistered test fails, and it is under-powered

Three CPU-only rerankers over each query's 10-candidate pool; NDCG@5 per query, means over 60 queries, KDD gains. BM25 IDF computed over the 600 sampled product texts only (the preregistered limitation). Bi-encoder: `sentence-transformers/all-MiniLM-L6-v2`, CPU.

| system | NDCG@5, human labels | NDCG@5, judge labels |
|---|---|---|
| BM25 | 0.8388 | 0.8596 |
| BiEncoder | 0.8672 | 0.8591 |
| RRF | 0.8569 | 0.8770 |

Ordering under human labels: **BiEncoder > RRF > BM25**. Under judge labels: **RRF > BM25 > BiEncoder**. Orderings differ; two of three pairwise delta signs flip. **By the preregistered test, system ordering is NOT preserved.** [measured: 60 queries]

The added paired bootstrap says why that result carries little information [measured: 10,000 replicates over 60 queries]:

| comparison | human labels | judge labels |
|---|---|---|
| BM25 − BiEncoder | −0.0285 [−0.0820, +0.0287] | +0.0005 [−0.0507, +0.0559] |
| BM25 − RRF | −0.0182 [−0.0501, +0.0135] | −0.0174 [−0.0534, +0.0179] |
| BiEncoder − RRF | +0.0103 [−0.0260, +0.0472] | −0.0179 [−0.0512, +0.0153] |

Every interval spans zero under **both** label sources. The three systems are statistically indistinguishable at n = 60 regardless of who labels, so "the ordering flipped" is a statement about which of three coin-flips landed where, not about the judge. Per-query NDCG@5 correlates at r = 0.551 between the two label sources (n = 180 system-query points), which is a moderate but not strong tracking relationship.

The honest reading: **this spike did not test comparative validity, it only thought it did.** Testing it needs either systems far enough apart to be separable at this n, or far more queries. That is now an open question rather than a settled one, and the amendment to `design.md` treats it as such. Note that this is the one place where the preregistration's design was weaker than it looked at the time it was written — 60 queries was sized for κ, and §4.4 measure 3 was quietly assumed to inherit that power. It does not.

### 5.4 Judge self-consistency

15 queries (150 pairs) re-run in fresh sessions with identical inputs [measured]:

- **96.7% of pairs received an identical label** across the two runs.
- **Judge–judge κ = 0.9397.**

The judge is stable enough to gate at k = 1 on reproducibility grounds, so branch F4 does not fire. But set this beside judge–human κ = 0.490 on the same scale: **the judge agrees with itself about twice as strongly (in chance-corrected terms) as it agrees with people.** That is the Fröbe finding reproduced in miniature [evidence: arXiv 2503.19092 citing Fröbe et al., SIGIR 2025, via S08]. Its practical meaning: re-running the judge buys almost nothing, so majority-of-3 would be wasted spend, and the residual disagreement with humans is *systematic*, not noise. You cannot average it away — you can only correct for it with human labels.

### 5.5 Contamination probe — clean

10 queries (100 pairs) re-run with product text removed; the judge saw only the query and the `product_id` [measured]:

| | accuracy vs human | κ |
|---|---|---|
| blind (query + product_id only) | **0.580** | 0.231 |
| same 100 pairs, with product text | 0.710 | 0.502 |
| majority-class rate in these 100 pairs (E) | 0.600 | — |

Blind accuracy (0.580) is **below** the majority-class rate (0.600). The preregistered trigger was the judge labelling "materially above the majority-class rate"; it did not. Its blind label distribution (E 60, S 28, C 10, I 2) is close to a prior over the natural class mix, which is what a non-memorising model guessing from the query alone should produce. **Branch F3 does not fire**: there is no evidence that this result is recall of a public dataset rather than evidence about the method. Sighted performance on the same 100 pairs (κ = 0.502) matches the full-sample figure, so these 10 queries are not an unrepresentative slice.

Caveat: this probe rules out product-identity memorisation via `product_id`. It cannot rule out that the model has absorbed ESCI's *labelling conventions* from the corpus. Nothing in this run can distinguish "learned the conventions from training data" from "inferred the conventions from the rubric", which is one more reason §10.4's calibration on the client's own labels stays a gating deliverable.

### 5.6 Cost and throughput

[measured: 85 calls, `total_cost_usd` summed; a client-side estimate that can differ from the actual bill, per the CLI docs]

| | calls | cost | median call |
|---|---|---|---|
| A — primary | 60 | $1.7712 | 7.8 s |
| B — contamination | 10 | $0.1669 | 6.5 s |
| C — self-consistency | 15 | $0.2585 | 8.2 s |
| **loop total** | **85** | **$2.1966** | 7.8 s (mean 8.2, max 17.5) |
| pilot (flag validation) | 4 | ≈$0.2135 | — |
| **grand total** | 89 | **≈$2.41** | — |

- **Cost per 1,000 labels: $2.95** (block A, 600 labels, $1.7712). [measured]
- Tokens across the 85 calls: 442,182 in (including cache reads and writes), 47,095 out.
- Throughput: 60 calls / 600 labels in 2.1 minutes at concurrency 4 on one laptop.

Against the preregistered estimate of ≈$1.87 for ~85 calls: the realised $2.20 is 18% above it, and *only because* of deviation 5 (shared prefix moved into the cached system prompt) and deviation 6 (5-minute cache TTL). The naive implementation measured $0.058/call in the pilot, which projects to $4.93 for the same 85 calls — 2.6x the estimate and over the hard limit. The §6 estimate was wrong in its token assumptions (2,400 in / 400 out assumed; ~5,200 in / ~550 out observed, the extra output being thinking tokens), and the stop rules existed for exactly this reason. Anyone quoting the $2.95/1,000 figure should quote the caching arrangement with it, because it is half the number.

---

## 6. What this result licenses, and what it does not

Stated as narrowly as §7 of the preregistration requires.

**Licensed:** the judge-first labelling scenario in `design.md` §10.3 is sound enough on a public product-relevance benchmark to be the *opening* proposal, with a human gold set and a disagreement queue sized against a measured κ of 0.49 rather than an assumed one. The judge is reproducible (κ_jj = 0.94), fast (600 labels in 2.1 minutes on a laptop), and cheap ($2.95/1,000 labels measured under the stated caching arrangement).

**Not licensed, and this list is not decoration:**

- **Nothing about any real retailer.** ESCI is Amazon's catalogue, Amazon's query mix, Amazon's rater guidelines. κ = 0.49 here is not a prediction about κ on a real retailer's labels. `design.md` §10.4 days 16–35 remains gating.
- **Nothing about Tier 2.** ESCI contains no sessions. Session-level task success is untested by this spike.
- **No absolute quality reporting from judge labels on the Irrelevant class.** Recall 0.146 means the judge cannot measure a top-k irrelevant rate, which §5.1 of the design asks it to measure.
- **No claim of comparative validity.** §5.3 above did not establish that judge labels preserve system rankings; it established that this spike could not tell. Reporting a judge-derived A-vs-B delta as if the ordering question were settled would be exactly the unverified measurement practice §12.1 of the design objects to in others.
- **No comparison to any published judge-agreement figure.** Preregistered in §4.3 and honoured here.

---

## 7. Which preregistered branch applies

| Branch | Condition | Fires? |
|---|---|---|
| F1 | κ fails AND ordering not preserved | no — κ passed |
| F2 | κ fails AND ordering preserved | no — κ passed |
| F3 | κ passes AND contamination indicates memorisation | no — blind accuracy 0.580 < majority rate 0.600 |
| F4 | self-consistency not materially better than judge–human | no — 0.940 vs 0.490 |
| *pass* | narrow conclusion, §6 above | **yes** |

The preregistration's decision table did not anticipate *κ passing while the ordering test fails*, because §7's ordering branches were written conditional on a κ failure. §4.4's rule governs: secondary measures cannot overturn a primary PASS. The verdict is PASS, and the ordering finding is carried into the amendment as an open question with a named way to resolve it, not as a silent omission.

---

## Appendix A — the rubric and the 8 in-context examples, verbatim

The exact contents of `rubric_full.md`, passed to every call via `--system-prompt`:

```
You are a product-relevance rater for an e-commerce search engine. You are given one
shopper search query and a numbered list of candidate products. For every candidate you
assign exactly one of four relevance labels.

LABEL DEFINITIONS

E — Exact. The product is relevant to the query and satisfies all of the query's
specifications (for example the stated product type, brand, size, colour, quantity,
model or compatibility). If the query is unspecific, a product of the requested type
that a shopper would accept as what they asked for is Exact.

S — Substitute. The product is somewhat relevant. It fails to satisfy some aspect of the
query — the wrong brand, the wrong size or colour, a different model, a different
quantity or a different form of the same thing — but a shopper could reasonably use it
instead of an Exact item. It is the same kind of thing, not quite what was asked for.

C — Complement. The product does not itself satisfy the query, but it is used together
with an item that would satisfy the query: an accessory, a refill, a consumable, a
mounting part, a case, a companion item. Complement is a different relation from
Substitute, not a weaker degree of Exact. Ask: would a shopper buy this *in addition to*
the thing they searched for, rather than *instead of* it?

I — Irrelevant. The product is irrelevant to the query, or it fails to satisfy a central
aspect of it: a different product category, a different intent, or a match only on an
incidental word.

HOW TO DECIDE

- Judge only from the query text and the product text supplied. Do not use outside
  knowledge of a specific listing, and do not speculate about attributes that are absent
  from the product text — judge what the text supports.
- Product text is truncated and noisy. Missing detail is not by itself grounds for
  Irrelevant if the product type plainly matches.
- Decide each candidate on its own. Do not balance the labels across a query, and do not
  assume any particular mix of labels is expected.
- Prefer the single best-fitting relation. When Exact and Substitute are both arguable,
  ask whether every stated specification in the query is met: if yes, Exact; if no, S.
- When Substitute and Complement are both arguable, ask the instead-of / in-addition-to
  question above.

OUTPUT

Return a label for every candidate, in the order given, using each candidate's
product_id exactly as supplied. Abstention is not permitted: there is no "unsure" label
and no candidate may be omitted. Output only the required JSON object and nothing else.

WORKED EXAMPLES

These eight examples show the four labels applied correctly.

1. query: "boat ropes for docking 25 ft"
   product: Extreme Max 3006.2129 BoatTector Double Braid Nylon Dock Line - 1/2" x 25', Royal Blue Extreme Max Royal Blue 1/2" premium double braid nylon dock line with spliced 12" soft eye and heat sealed bitter end Nylon has great strength and shock load resistance and handles easily; it's resistant to saltwater, gas, oil, acids, abrasion, and resists UV better than all other synthetics Suitable for 20' to 30' boats (Working Load Limit: 870 lbs./Breaking Strength: 4,380 lbs.) Double braid is ideal for doc
   correct label: E

2. query: "pajamas for boys"
   product: Calvin Klein Boys' Lounge Pajama Shorts, 2 Pack, Sharks/Black, 10-12 Calvin Klein Sharks/Black 2 pack pajama bottom for boys Bottom features a wide elasticized waistband for extra comfort Extremely soft and comfortable Features our signature Calvin Klein logo
   correct label: E

3. query: "ellora olive oil"
   product: Mythology Greek Organic Cold Pressed Olive Oil Extra Virgin, USDA Organic Olive Oil Extra Virgin, Greek Olive Oil From Greece Cold Pressed PDO Certified - 3 Liter Mythology ORGANIC FIRST COLD PRESSED OLIVE OIL - Our olive oil is and extracted only once from our olives under strictly controlled conditions in low-temperatures. Giving Mythology EVOO the highest and purest quality with an incredibly low acidity of 0.5%. HARVESTED IN GREECE - Mythology cold pressed greek olive oil is produced from ol
   correct label: S

4. query: "engineer i'm not arguing funny engineering t-shirt"
   product: Funny Mechanical Engineer T-shirt I Can't Fix Stupid Tee I Am A Mechanical Engineer I Can't Fix Stupid Black I'm a mechanical engineer I can't fix stupid but I can fix what stupid does tshirt. Funny humor shirt for a mechanical engineer who studied mechanical engineering at college as a student. Gift to your teacher, professor or wear it to class. Perfect birthday gift for mechanical engineering major graduates who like funny sarcastic quotes and can fix stupid things that people do. Great gift 
   correct label: S

5. query: "earphone guards"
   product: WR-HUYUER 1 Set Camouflage Dust Guard Protective Sticker Earphone Case Shell Skin Dust-Proof for Airpods 1/2 Charging Box WR-HUYUER As shown The thickness of the plate is 0.04mm. Experience flawless use of the case with the Dust Guard installed. No cutting needed. Easy to apply without air bubbles leaves no residue when removed. Easy to clean and will not damage the Airpods 1/2 surface. Slim lightweight design without adding bulk to your charging box. 4 colors available for your choices to perso
   correct label: C

6. query: "mineral fusion nail polish remover"
   product: Nail Polish Remover Clips 30PCS Acrylic Nail Art Polish Remover Wrap Cleaner Soak Off Clip Caps with Cuticle Pusher Cutter HiMo Pink,Purple,White 30pcs nail clips = 10pc pink + 10pc purple + 10pc white + 1pc Cuticle Pusher. Abundant gel nail polish cleaner clips are great for your replacement whenever you want. They are also reusable, saving your money. This fast nail polish remover tool allows you to change nail polishes you like anytime, matching different dressing styles. The gel polish remov
   correct label: C

7. query: "babygate pads"
   product: Regalo Easy Open 47-Inch Super Wide Walk Thru Baby Gate, Bonus Kit, Includes 4-Inch and 12-Inch Extension Kit, 4 Pack Pressure Mount Kit and 4 Wall Cups and Mounting Kit , 11 Count (Pack of 1) Regalo White EXTRA WIDE: Expands to fit openings between 29-38 and 42-47 inches wide. Stands 30 inches tall. Please be sure measure your opening prior to purchase to ensure proper fit EASY TO USE AND SET UP: Pressure mount design that is quick to set up. Please note, before installation there will be a gap
   correct label: I

8. query: "galaxy s10 case cute"
   product: BAISRKE Marble Case for Galaxy S10 Plus, Shiny Rose Gold Lines Wave Geometric Design Case Slim Soft TPU Rubber Bumper Silicone Protective Phone Case Cover for Galaxy S10+ Plus 6.4 [Black] BAISRKE Black Compatible with Samsung Galaxy S10 Plus 6.4 inch (2019 Release),Support wireless charging Special pattern on the case makes your phone different and eyes-catching Protect your phone from scratches, bumps and other daily damage Access to all the controls and features; Perfect cutouts for speakers, 
   correct label: I
```

Source rows for the 8 examples (`icl_examples.jsonl`, drawn from `split == "train"`, US locale, seed 20260916):

| label | query | product_id |
|---|---|---|
| E | boat ropes for docking 25 ft | B00W12IC8C |
| E | pajamas for boys | B07ZSD268P |
| S | ellora olive oil | B0178HFBN8 |
| S | engineer i'm not arguing funny engineering t-shirt | B07L23P52N |
| C | earphone guards | B07XSWLHB8 |
| C | mineral fusion nail polish remover | B081LDFFBQ |
| I | babygate pads | B001OC5UNK |
| I | galaxy s10 case cute | B07RJQWLMN |

---

## Appendix B — the sample

**Seed:** 20260916. **The 60 drawn query_ids:**

```
2353, 4109, 4837, 5110, 5842, 15226, 17070, 19101, 19628, 19720, 19782, 21015,
23196, 24534, 25367, 26177, 26410, 37310, 38792, 38914, 39258, 39284, 43579,
47412, 48341, 53807, 56674, 58311, 60098, 62930, 64982, 68660, 69923, 71472,
74220, 74337, 74681, 75777, 75908, 76358, 76647, 77205, 79527, 80036, 81100,
81852, 84243, 84456, 84865, 85561, 90512, 94434, 95162, 95366, 100063, 103255,
107020, 107077, 113331, 115816
```

Contamination probe (block B) used the first 10 of these; self-consistency (block C) the first 15.

**The 600 example_ids** are in `example_ids.txt` (comma-separated, sample order) and, with their query, product_id, human label and the exact product text sent to the judge, in `manifest.jsonl` — one JSON object per pair, 600 lines.

---

## Appendix C — files and reproduction

| file | what it is |
|---|---|
| `sample.py` | draws the 600 pairs and the 8 in-context examples from the parquet files |
| `rubric.md` | the rubric alone |
| `rubric_full.md` | rubric + the 8 in-context examples — the actual system prompt |
| `judge.py` | the judge loop: blocks A, B, C, concurrency 4, §6 cost and time stops |
| `analyse.py` | primary κ, cluster bootstrap, weighted κ, confusion, per-class, self-consistency, contamination, cost |
| `rankers.py` | secondary 3: BM25 / bi-encoder / RRF, NDCG@5 under both label sources |
| `manifest.jsonl` | 600 pairs: example_id, query_id, query, product_id, human label, product text as sent |
| `icl_examples.jsonl` | the 8 in-context examples |
| `raw_calls.jsonl` | one record per CLI call: tag, attempt, `total_cost_usd`, usage, model, session_id, returned labels |
| `primary.json`, `rankers.json`, `bootstrap.npy` | computed results and the 10,000 bootstrap replicates |
| `example_ids.txt` | the 600 example_ids |

To reproduce end to end:

```
python -m venv .venv && ./.venv/bin/pip install pandas pyarrow numpy scikit-learn sentence-transformers
./.venv/bin/python sample.py
CLAUDE_CODE_PROMPT_CACHE_TTL=5m ./.venv/bin/python judge.py raw_calls.jsonl ABC
./.venv/bin/python analyse.py
./.venv/bin/python rankers.py
```

Environment: Claude Code CLI 2.1.246, model `claude-opus-5[1m]`, macOS on Apple Silicon, CPU only, Python 3.12. Sampling, bootstrap and ranker analysis are deterministic under seed 20260916; the judge calls are not deterministic, and §5.4 measures how much that matters (96.7% label-identical on re-run).
