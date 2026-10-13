# Wave 0 user stories: storefront, chat and split view

These stories describe the storefront (`/shop`) and the chat assistant working on **one shared session**.
Every story names the Playwright spec in `web/e2e/` that proves it. The specs run against the live
services: search-svc over the ESCI catalogue, shop-http, the bff and the Claude CLI agent. Nothing is mocked.

> [!IMPORTANT]
> The products and queries come from the public Amazon ESCI dataset. Price, promo, stock, stores and
> eligibility are **synthetic commerce data (ESCI has no price or stock)**. The help corpus
> (`data/help_corpus.json`) was written for this demo and is **not any real retailer's policy**. No payment is taken.

Run: `cd web && npx playwright test` (the stack must be up; see `web/playwright.config.ts` for ports).
Specs tagged `@agent` drive a real Claude CLI turn and take 1–3 minutes each.

## Shopper on the site

| ID | Story | Acceptance (Given / When / Then) | Spec |
|---|---|---|---|
| S1 | Find a product by search | **Given** the storefront home, **when** I search "peanut butter", **then** result cards from the ESCI catalogue show price, rating and pickup status. | `site-search.spec.ts` |
| S2 | Narrow with facets | **Given** results for "pasta", **when** I tick a dietary facet and sort by price low to high, **then** every card carries that tag and prices are non-decreasing. | `site-facets.spec.ts` |
| S3 | Page through results | **Given** a broad query, **when** I go to page 2, **then** the page marker is `aria-current` and different products are shown. | `site-facets.spec.ts` |
| S4 | Recover from a zero result | **Given** filters that match nothing, **when** the result set is empty, **then** I see the closest relaxation with its count, can apply it in one click, and the page says a triage record was filed. | `site-zero-result.spec.ts` |
| S5 | Understand a product | **Given** a product page, **when** it loads, **then** attributes carry T1/T2/T3 trust badges with a legend, store stock and pickup ETA are shown, and the synthetic data label is visible. | `site-pdp.spec.ts` |
| S6 | Build and edit a cart | **Given** a product, **when** I add it, change quantity and remove it, **then** the header cart count follows each step. | `site-cart.spec.ts` |
| S7 | Checkout without payment | **Given** a cart, **when** I open checkout, **then** it revalidates, I can sign a mandate and see its signature, the page says no payment is taken, and approval creates an order in history. | `site-checkout.spec.ts` |
| S8 | Checkout revalidates stock | **Given** an item in the cart, **when** it goes out of stock before checkout, **then** revalidation blocks signing and offers a substitute. | `site-checkout.spec.ts` |
| S9 | Pick my store | **Given** the store picker, **when** I choose another store, **then** the header shows it and stock and pickup are computed for that store. | `site-store.spec.ts` |
| S10 | Return to a saved list | **Given** I saved a product to a list, **when** I reload the site later, **then** the list and my cart are still there. | `site-lists.spec.ts` |
| S11 | Ask a non-product question | **Given** the search box, **when** I type "what is your return policy", **then** I get a cited answer from the help corpus, not product cards. | `site-help.spec.ts` |
| S12 | Degraded catalogue service | **Given** the promo service is down, **when** I open a product, **then** the page says promo is unavailable and still shows list price and stock. | `site-pdp.spec.ts` |
| S13 | Home page is accessible | **Given** the `/shop` home page, **when** it loads, **then** it has one `h1` and passes the same axe check (no serious or critical violations) as every other store page. | `a11y.spec.ts` |
| S14 | See mission and category tiles at a glance | **Given** the `/shop` home page, **when** it renders, **then** category tiles and mission cards each link into a search. | `site-search.spec.ts` |
| S6b | Cart count survives into checkout | **Given** an item already in the cart, **when** I open checkout, **then** the header cart count is unchanged until the order is approved, then it returns to 0. | `site-checkout.spec.ts` |
| S15 | Shop as a synthetic persona | **Given** the store header, **when** I pick a shopper from the persona switcher, **then** the header names that synthetic shopper, their stored preferences arrive as constraint chips and remembered facts, and my cart is kept. | `account-persona.spec.ts` |
| S16 | See my account and where my preferences came from | **Given** `/shop/account`, **when** it loads, **then** it shows the persona identity, the same B11 constraint chips and memory rows the assistant uses, and links to wallet, addresses and orders. | `account-persona.spec.ts` |
| S17 | Manage my addresses | **Given** `/shop/account/addresses`, **when** I add, edit, re-default and remove an address, **then** each change sticks and exactly one address stays the default. | `account-persona.spec.ts` |
| S18 | See what each demo card will do before I use it | **Given** `/shop/account/wallet`, **when** it loads, **then** every instrument shows its deliberate outcome as a badge ("test card: declines", "test card: needs verification") and exactly one is the default. | `account-wallet.spec.ts` |
| S19 | Add a payment instrument safely | **Given** the wallet's add form, **when** it loads, **then** a permanent warning says never to enter a real card number and the accepted published test numbers fill the field in one click. | `account-wallet.spec.ts` |
| S20 | A real-looking card number is refused without echoing it | **Given** the add form, **when** I submit a plausible number outside the allowlist, **then** the API's own error and accepted list are shown, nothing is added, and no response or page contains the digits I typed. | `account-wallet.spec.ts` |
| S21 | Manage my wallet | **Given** a stored instrument, **when** I edit its label, make it the default or remove it, **then** the change sticks, removing the default promotes another, and there is nothing card-like to edit because no number is ever stored. | `account-wallet.spec.ts` |
| S22 | Choose how to pay at checkout | **Given** a cart and a persona, **when** I open checkout, **then** a payment step between the cart check and the mandate lets me pick an address and one or more instruments, and shows the tender plan it would authorise. | `checkout-payment.spec.ts` |
| S23 | Approve a simulated authorisation | **Given** a signed mandate naming an approving test card, **when** I approve it, **then** a simulated authorisation is recorded with an auth reference and I land on the order confirmation, with no payment executed. | `checkout-payment.spec.ts` |
| S24 | A declined card creates no order | **Given** a mandate naming the declining test card, **when** I approve it, **then** the page says the authorisation was declined, that no order was created and that the mandate is dead, and offers to sign a new one with another instrument. | `checkout-payment.spec.ts` |
| S25 | A card that needs verification | **Given** a mandate naming the step-up test card, **when** I approve it, **then** a verification panel appears, a wrong code is rejected with the attempts remaining, and the right code completes the simulated authorisation. | `checkout-payment.spec.ts` |
| S26 | Split a basket across EBT and a card | **Given** a basket of SNAP-eligible and non-eligible lines, **when** I pick EBT and a card, **then** the tender plan splits along SNAP eligibility and nothing is left uncovered. | `checkout-tender.spec.ts` |
| S27 | EBT alone is refused, with the rule quoted | **Given** the same basket with EBT only, **when** the plan is worked out, **then** a blocking refusal quotes the eligibility rule verbatim and no mandate can be signed until a second instrument is added. | `checkout-tender.spec.ts` |
| S28 | The mandate names the tender it was signed over | **Given** a previewed tender plan, **when** I sign the mandate, **then** the mandate carries those tender rows, the preview's tender hash and the chosen address, and `payment_executed` is false. | `checkout-tender.spec.ts` |
| S29 | Read my order confirmation | **Given** a placed order, **when** I open `/shop/order/:orderId`, **then** it shows the order id, `payment_executed: no`, each tender leg with brand, last four, amount and what it covers, the auth reference in a code block with its note, and the address. | `order-confirmation.spec.ts` |
| S30 | Watch a demo order progress | **Given** an order confirmation, **when** I use the demo fulfilment control, **then** the stepper advances through placed, preparing, ready for pickup and picked up, and says the progress is simulated. | `order-confirmation.spec.ts` |
| S31 | Find a past order | **Given** `/shop/orders`, **when** it loads, **then** each row links to its confirmation and shows its tender summary and fulfilment badge, and I can narrow the list from this session to this shopper's orders. | `order-history.spec.ts` |
| S32 | Reorder my usual items | **Given** a past order, **when** I press Reorder, **then** the existing reorder path proposes my usual items as pending actions for approval in chat rather than writing to the cart silently. | `order-history.spec.ts` |
| S33 | The account and payment surfaces are accessible | **Given** the account, wallet, addresses, payment step, order history and confirmation routes, **when** they load at 390px in light and dark, **then** each has one `h1` and passes the same axe check as every other store page. | `a11y.spec.ts` |

## Shopper in chat

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| C1 | Switch to chat | **Given** any store page, **when** I press Alt+2 or pick Chat, **then** the assistant fills the view with a mini cart and constraint chips, and `?view=chat` is in the URL. | `layout-toggle.spec.ts` |
| C2 | State a constraint | **Given** chat, **when** I say "nut-free snacks for school", **then** a removable nut-free chip appears. Its explanation quotes my message and says it is a title-keyword check. | `chat-constraints.spec.ts` @agent |
| C3 | See what could not be done | **Given** a nut-free constraint and a cart, **when** the turn ends, **then** "What I could not do" says nut-free cannot be verified because the catalogue has no allergen data. | `chat-constraints.spec.ts` @agent |
| C3B | Could-not-do reason lands in the session record | **Given** the same nut-free scenario end to end, **when** the turn finishes, **then** the session's `could_not` list itself (not just the UI) records a nut-related reason. | `walkthrough.spec.ts` @agent |

## Shopper in split view

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| X1 | Chat search drives the site | **Given** split view, **when** I ask the chat to find creamy peanut butter and add the cheapest jar, **then** the site pane navigates to the results for the agent's query and marks the agent's picks "Found by Compass". | `sync-agent-to-site.spec.ts` @agent |
| X2 | Chat cart shows on the site | **Given** split view, **when** the agent adds an item, **then** the site's cart count updates without a reload. | `sync-agent-to-site.spec.ts` @agent |
| X3 | Site edits reach the agent | **Given** an item the agent added, **when** I remove it on the site, **then** the chat activity shows the removal, and the agent's next turn is told about it and re-plans. | `sync-site-to-agent.spec.ts` @agent |
| X4 | Constraint from chat filters the site | **Given** a nut-free constraint stated in chat, **when** I browse the site, **then** results are filtered and a removable chip explains why; removing it restores the results. | `sync-site-to-agent.spec.ts` |
| X5 | Resize and stack | **Given** split view, **when** I drag or use the arrow keys on the divider, **then** the panes resize; at 390px they stack with Store/Chat tabs. | `layout-toggle.spec.ts` |
| SS1 | Agent change reaches the site pane live | **Given** split view on one shared session, **when** the agent adds an item, **then** the site pane's cart count updates over the session SSE stream without a page reload. | `sync-agent-to-site.spec.ts` @agent |
| SS2 | Site change reaches the chat pane live | **Given** split view, **when** I remove an item on the site, **then** the same SSE stream carries it into the chat's site-activity feed without a reload. | `sync-site-to-agent.spec.ts` |
| B1 | Beat 1 headline meets goal and budget | **Given** the beat 1 prompt ("coffee and #4 cone filters under $25") in split view, **when** Planner, Shopper and Critic run and I approve each proposal, **then** ground coffee and #4 cone filters are both in the cart and the total is at most $25. | `beat1-headline.spec.ts` @agent |
| B2 | Beat 1 leaves no pending action and is audited | **Given** the same beat 1 run, **when** it finishes, **then** the audit log includes both a "proposed" and an "approved" event and no pending action remains. | `beat1-headline.spec.ts` @agent |

## Spanish-speaking shopper

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| ES1 | Help in Spanish | **Given** the search box, **when** I type "¿cómo devuelvo un producto?", **then** the help intent routes it and the answer is in Spanish with citations. | `spanish.spec.ts` |
| ES2 | Spanish constraint | **Given** the site session, **when** a constraint "sin gluten" is stated, **then** the gluten-free filter applies to search. | `spanish.spec.ts` |

## Shopper using a screen reader

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| A1 | Landmarks and no serious violations | **Given** home, results, product, cart and checkout, **when** axe-core runs, **then** there are no serious or critical violations and each page has one `h1`, `main`, `nav` and `contentinfo`. | `a11y.spec.ts` |
| A2 | Announced sync | **Given** split view, **when** the cart changes from the other channel, **then** a polite live region announces it. | `a11y.spec.ts` |

## Store associate handoff

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| H1 | Order is ready for pickup prep | **Given** an approved mandate, **when** the order is created, **then** order history shows the lines, store, total and "no payment taken" for the associate to pick. | `site-checkout.spec.ts` |

## Operator: triage

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| O1 | Triage zero results | **Given** a zero-result search, **when** I open `/triage`, **then** the record shows query, filters, store and relaxation, and I can acknowledge and resolve it. | `triage.spec.ts` |
| O1B | Triage record exists before an operator looks | **Given** a zero-result search happens, **when** no operator has opened `/triage` yet, **then** the record is already filed and visible as a row once `/triage` is opened. | `walkthrough.spec.ts` |

## Merchandiser / retail media: sponsored disclosure

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| M1 | Sponsored is labelled and capped | **Given** search results containing sponsored listings, **when** they render, **then** each carries a visible "Sponsored" label and at most 1 in 8 results is sponsored. | `sponsored.spec.ts` |

## Wave 0b: Compass chat and AI capabilities

Every capability below runs on live services (Claude CLI agent through policy-mcp, search-svc, shop-http catalogue services). Prices and stock are synthetic commerce data (ESCI has no price or stock). Specs tagged `@agent` run real Claude turns and log a per-turn cost note in the Playwright output (`[cost] ...` and a `cost` annotation).

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| AI1 | See how Compass worked | **Given** a chat turn, **when** it finishes, **then** "How Compass worked" shows the plan steps (Planner, Shopper, Critic) from AG-UI STEP events, each tool call with args and result, the Critic verdict, latency and the cost of that turn, and links to `/ops/replay/<runId>`. | `ai-timeline.spec.ts` |
| AI1b | Rate an answer | **Given** a finished answer, **when** I press 👎 and pick a reason, **then** it is stored as an online-eval sample (technique 29) in `data/online_feedback.jsonl`. | `ai-timeline.spec.ts` |
| AI1c | Edit, regenerate, stop | **Given** my last message, **when** I edit and resend it, **then** it replaces the original and the answer is regenerated; **when** I press Stop mid-run, **then** generation stops and I can send again. | `ai-timeline.spec.ts` |
| AI2 | Photo to products | **Given** a photo, **when** I attach it, **then** Claude extracts the items and attributes, search-svc matches each by text, and the card states that matching is text-based because ESCI has no images. | `ai-photo.spec.ts` |
| AI3 | Voice in and out, EN/ES | **Given** a browser without the Web Speech API, **when** I press the mic, **then** I see "not supported" and can type instead; the transcript box stays editable before send, and no audio is stored. | `ai-voice.spec.ts` |
| AI3b | Reply in my language | **Given** I write in Spanish, **when** Compass answers, **then** the reply language is auto-detected and the answer is Spanish. | `ai-voice.spec.ts` |
| AI4 | Grounded claims | **Given** an answer about products, **when** it finishes, **then** claim chips show the PDP attribute with trust tier T1/T2/T3 and link to that attribute; T3-only claims are phrased "Possibly … (unverified)". | `ai-citations.spec.ts` |
| AI5 | Compare mode | **Given** a search, **when** I type `/compare`, **then** an A2UI table shows price, size, unit price, dietary, rating and stock from the catalogue services, with a recommendation and its reason. | `ai-compare.spec.ts` |
| AI6 | Editable mission plan | **Given** `/plan pasta night for 4`, **when** the agent's plan arrives, **then** I can change quantities, swap or remove lines before anything reaches the cart, and the B09 verifier re-runs on every edit. | `ai-planner.spec.ts` |
| AI7 | Approve agent actions, with undo | **Given** an agent-proposed cart change (chat or reorder), **when** it is proposed, **then** nothing changes until I approve; approve applies it, undo reverses it, reject leaves the cart untouched, and the audit log records proposed/approved/undone/rejected. | `ai-hitl.spec.ts`, `sync-agent-to-site.spec.ts` |
| AI8 | I control memory | **Given** the memory panel, **when** I add, edit or delete dietary needs, brands, store or household size, **then** each shows its source and date; a need Compass infers from chat is quarantined ("Not saved") until I confirm it, and only confirmed memory reaches the agent. | `ai-memory.spec.ts` |
| AI9 | Follow-ups and one clarifying question | **Given** an ambiguous goal, **when** the turn finishes, **then** I get at most one clarifying question with option chips and/or follow-up chips, and clicking one sends it. | `ai-followups.spec.ts` |
| AI10 | Watches and reorder | **Given** a cart item that is out of stock, **when** I start a back-in-stock watch and the inventory service restocks it, **then** the timer (or Check now) evaluates the watch and an in-app notification appears, labelled synthetic; "reorder my usual" proposes items from my past orders for approval. | `ai-watches.spec.ts`, `ai-hitl.spec.ts` |
| AI1D | Timeline names each tool call | **Given** the same finished chat turn, **when** "How Compass worked" is open, **then** each tool call listed names the tool (for example `search_products`) alongside its args and result. | `ai-timeline.spec.ts` @agent |
| AI2B | Photo cost note says synthetic | **Given** the same photo-to-products turn, **when** its cost note is shown, **then** it explicitly says "synthetic commerce data" rather than a bare price figure. | `ai-photo.spec.ts` @agent |
| AI4B | Citation link matches the cited product | **Given** a product's citations, **when** I call the citations endpoint for it directly, **then** every claim's link points at that same product's PDP anchor for the cited attribute. | `ai-citations.spec.ts` |
| AI5B | Compare rows carry a unit price | **Given** a `/compare` result, **when** I read its rows via the API, **then** every row has a `unit_price_label` and the recommended product id is one of the compared rows. | `ai-compare.spec.ts` |
| AI6B | Removing a plan line re-verifies | **Given** a mission plan with more than one line, **when** I remove a line, **then** the plan has one fewer line and the verifier's `checked_at` timestamp is refreshed. | `ai-planner.spec.ts` @agent |
| AI7B | Reject leaves the cart untouched | **Given** a pending agent proposal, **when** I reject it instead of approving, **then** the cart is unchanged and the audit log's last entry is `rejected` by `shopper`. | `ai-hitl.spec.ts` |
| AI8B | Inferred need is quarantined until confirmed | **Given** a dietary need Compass infers from chat, **when** it first appears, **then** the memory panel shows "1 to confirm" and the record's status is `quarantined` with `origin: inferred` until I confirm it. | `ai-memory.spec.ts` @agent |
| AI9B | Clicking a follow-up sends it verbatim | **Given** follow-up chips are shown, **when** I click one, **then** it appears as my next chat message with that exact label. | `ai-followups.spec.ts` @agent |
| AI10B | Watch baseline comes from the price service | **Given** a new back-in-stock watch, **when** I read its baseline price, **then** it matches the price service's own quote for that product, and starting a watch on an unknown product is refused. | `ai-watches.spec.ts` |
| REP1 | Step through a recorded run | **Given** a recorded run, **when** I open `/ops/replay/:runId`, **then** a scrub slider lets me step through the recorded frames of that run. | `walkthrough.spec.ts` |
| A3 | Accessible chat chrome | **Given** the chat with an approval card, command menu and memory panel, **when** axe-core runs in light and dark, **then** there are no serious violations, and the command menu works by keyboard. | `a11y.spec.ts` |

## Streaming (Phase 1)

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| ST1 | See the answer as it is written | **Given** a shopper or Ops Copilot question, **when** the model starts answering, **then** the first words appear before the answer is complete (with a streaming cursor), screen readers get whole sentences at most every 4 s through a polite live region, and Stop aborts the CLI run mid-stream. | `stream-first-token.spec.ts`, `ai-timeline.spec.ts` |
| ST2 | Know whether the answer was checked | **Given** a streamed shopper answer, **when** the verifier and Critic finish, **then** the answer carries a "checked ✓" or "revised" badge; a rejected draft stays visible struck through as superseded and the revised answer streams below it. Planner and Critic output streams into "How Compass worked". | `stream-first-token.spec.ts` |

## Ops Copilot top 10 (Phase 3)

Every capability is a real ops-mcp tool (`services/ops-mcp/src/ops_mcp/copilot.py`) the Ops Copilot calls through policy-mcp, rendered as an A2UI card that cites its records. The spec backs up and restores `data/registry.json` and `data/ops.db`. Screenshots: `docs/ui/ops_<n>_*.png`.

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| OPS1 | Triage an incident | **Given** the Ops Copilot, **when** I ask it to triage the latest incident, **then** a card correlates the latest drift alert, deploy/canary/gate audit entries and live canary status, ranks findings by severity, cites each record (alert id, `audit#id`, `gate#id`, `/canary/status`) and labels time correlation as not causal. | `ops-copilot-top10.spec.ts` |
| OPS2 | Ask for a metric in plain English | **Given** a metric question (e.g. NDCG@10 per registry version), **when** the Copilot answers, **then** an inline chart and table show the real series from its source (registry, gates, alerts, online evals, slices or the token ledger) with n; an unknown metric returns the catalog instead of a guess. | `ops-copilot-top10.spec.ts` |
| OPS3 | Run a runbook with the right autonomy | **Given** a T2 runbook (re-run the eval gate), **when** I ask the Copilot to run it, **then** an approval card appears that the agent cannot approve; **when** I approve, **then** it runs once, the card shows the result and an audit entry with the approval id is written. T0/T1/T3 runbooks run immediately and are audited. | `ops-copilot-top10.spec.ts` |
| OPS4 | Get release notes and a model card | **Given** a candidate, **when** I ask for release notes, **then** they list the config diff vs the champion, registry metrics, the latest eval gate with its CI and n, and a model card with the ML-BOM path (or says it is not generated). | `ops-copilot-top10.spec.ts` |
| OPS5 | Compare champion and candidate | **Given** two versions, **when** I ask to compare them, **then** a table shows every registry metric side by side with deltas, the paired NDCG@10 CI from the gate and query-type slices for each retrieval mode. | `ops-copilot-top10.spec.ts` |
| OPS6 | Understand drift | **Given** a drift alert, **when** I ask which slices moved, **then** the card shows each query type's share in the reference vs the latest seasonal window, the largest shift, rising terms and example queries from `seasonal_queries`. | `ops-copilot-top10.spec.ts` |
| OPS7 | See where evals fail | **Given** the slice report, **when** I ask to cluster eval failures, **then** query types below the overall NDCG@10 are listed with n, gap and CI, each with a suggested fix marked proposal only; nothing is changed. | `ops-copilot-top10.spec.ts` |
| OPS8 | Watch cost and tokens | **Given** `data/token_ledger.jsonl`, **when** I ask about cost or open the "Cost & tokens" dashboard view, **then** I see cost, tokens and cache hit by role and model, spend per hour and anomaly alerts with their rule. | `ops-copilot-top10.spec.ts` |
| OPS9 | Find out what went wrong in a run | **Given** a recorded run id, **when** I ask what went wrong, **then** the card lists refused, errored or slow tools, stalls, refusals, guard blocks and Critic rejections, each cited to the run record, or says nothing went wrong. | `ops-copilot-top10.spec.ts` |
| OPS10 | Be told before I ask | **Given** a red gate, a drift p-value below 0.05 or a canary breach, **when** I open the Alerts bell on the Ops Copilot dock, **then** each alert shows its record and a suggested next action; clicking it sends that question to the Copilot. The panel and chat are axe clean. | `ops-copilot-top10.spec.ts` |
| OPS1B | Incident triage cites a concrete record | **Given** the same incident-triage answer, **when** I read it, **then** it names at least one of an alert id, an `audit#id`, a `gate#id` or `/canary/status` inline in the text. | `ops-copilot-top10.spec.ts` |
| OPS2B | Metric answer states its n | **Given** the metric-query answer, **when** it renders, **then** it states the sample size as `n = <number>` next to the chart. | `ops-copilot-top10.spec.ts` |
| OPS3B | Runbook audit entry carries the approval id | **Given** the T2 runbook is approved and runs, **when** it finishes, **then** the audit log has an entry with action `runbook:rerun_eval_gate` and that approval's id. | `ops-copilot-top10.spec.ts` |
| OPS4B | Release notes name their source | **Given** the release-notes answer, **when** it renders, **then** it states its data source as `search-svc /models`. | `ops-copilot-top10.spec.ts` |
| OPS5B | Compare names both versions | **Given** the compare answer, **when** it renders, **then** it names both versions being compared and includes `test_ndcg10`. | `ops-copilot-top10.spec.ts` |
| OPS6B | Drift answer names its example source | **Given** the drift answer, **when** it renders, **then** it names `seasonal_queries` as the source of its example queries. | `ops-copilot-top10.spec.ts` |
| OPS7B | Eval-failure fixes are proposals only | **Given** the eval-failure-cluster answer, **when** it renders, **then** every suggested fix is marked as a proposal, and nothing in the running system has changed. | `ops-copilot-top10.spec.ts` |
| OPS8B | Cost dashboard works standalone | **Given** the "Cost & tokens" dashboard opened directly (not via chat), **when** it loads, **then** it shows a dollar total over a model-call count and a table of the underlying rows. | `ops-copilot-top10.spec.ts` |
| OPS9B | What-went-wrong cites the run record | **Given** a recorded run id, **when** I ask what went wrong, **then** the answer cites the `agui_runs` record backing it. | `ops-copilot-top10.spec.ts` |
| OPS10B | Watch panel is accessible | **Given** the Ops Copilot watch bell panel is open, **when** axe-core runs, **then** the panel and the chat region both have no serious violations. | `ops-copilot-top10.spec.ts` |

## MLOps top 10 (MLO1–MLO10)

Capabilities from `docs/MLOPS_TOP10_SELECTION.md`. Each is a real ops-mcp tool (`services/ops-mcp/src/ops_mcp/mlops_top10.py`) the Ops Copilot calls through policy-mcp with its autonomy tier, rendered as an `ops_insight` card that cites its records. Every run writes `docs/evidence/mlops_<n>_<slug>.json`, surfaced in `data/coverage.json` → `mlops_top10` with n and CI (or why there is none). The spec backs up and restores `data/registry.json` and `data/ops.db`. Screenshots: `docs/ui/mlops_<n>_*.png`.

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| MLO1 | Pre-screen a ranking change with interleaving | **Given** two live rankers (default `rrf_rerank` vs `rrf`), **when** I ask the Copilot to interleave them, **then** a T1 card shows team-draft wins/losses/ties over n ESCI test queries, the sign-test p, a bootstrap CI on the preference and interleave-vs-split-A/B p at growing n; clicks are labelled SIMULATED from ESCI judgments, and advancing to an A/B is left to a human. | `mlops-top10.spec.ts` |
| MLO2 | Read an A/B result with CUPED and a sequential test | **Given** `data/online_sessions.jsonl`, **when** I ask for a CUPED + sequential A/B, **then** a T1 card shows n per arm, the CUPED variance reduction and θ, raw vs CUPED ΔNDCG@10 with CI95, and where the mSPRT always-valid p crossed α (or that it did not); it states that arms are re-randomised over logged sessions and the outcome is offline NDCG@10, and the ship call stays human. | `mlops-top10.spec.ts` |
| MLO3 | Catch training–serving skew before promotion | **Given** training features (`products.parquet`) and the serving tables (`commerce.db`), **when** I ask for a skew check on a version, **then** a T2 card shows PSI, KS and rows changed per feature; **when** any PSI exceeds the threshold, **then** a `skew_review` approval is opened and `promote` for that version is refused until a human approves it. | `mlops-top10.spec.ts` |
| MLO4 | Trace lineage of a model | **Given** the registry, MLflow runs and ops.db gates, **when** I ask where the champion came from and what depends on it, **then** a read-only T0 card lists upstream and downstream edges (parent version, index artefacts, remediation, MLflow run and model version, eval gates, serving path), each citing its record, and says which edges are declared from code rather than logged. | `mlops-top10.spec.ts` |
| MLO5 | Decide whether to retrain | **Given** live drift and the label profile, **when** I ask whether to retrain, **then** a T2 card shows each DAG step with status and seconds; a fast-label profile auto-fires (records the alert and hands off to remediation + eval gate), a delayed-label profile opens a `retrain_signoff` approval and waits, and the promote step is always "requires human". | `mlops-top10.spec.ts` |
| MLO6 | Audit sponsored vs organic exposure | **Given** live rankings on ESCI test queries and the catalogue's sponsored flag, **when** I ask for a fairness / exposure audit, **then** a T1 card shows the position-weighted sponsored exposure share vs a relevance-matched baseline (same items ordered by ESCI gain) with a bootstrap CI on the gap, the sponsored slot share vs catalogue rate and brand concentration (HHI); it states that 1P vs 3P is not measurable (no seller field) and remediation is a human decision. | `mlops-top10.spec.ts` |
| MLO7 | Govern prompt/agent config changes | **Given** the bff prompts/models config (`ops/prompt.ts`, `agents/roles.ts`, `config.ts`), **when** I ask what changed in the agent config, **then** a T2 card shows the hashed config version registered in ops.db, the file/model diff vs the previous version and an eval-on-change over `data/token_ledger.jsonl` turns before vs after (ok-rate, cost CI, p95 per role); a regression opens `config_regression` and blocks merge; **when** I ask to roll back to a version, **then** a `config_rollback` approval opens and the files are restored only after a human approves it. | `mlops-top10.spec.ts` |
| MLO8 | Freeze releases when the error budget is spent | **Given** search-latency and agent-turn SLOs over logged sessions and the token ledger, **when** I ask for SLO / error-budget status, **then** a T2 card shows n, bad fraction (Wilson CI), burn rate and budget left per SLO; **when** a budget is exhausted, **then** a release freeze opens and `promote` is refused until a human approves the `release_freeze_override`. | `mlops-top10.spec.ts` |
| MLO9 | Catch golden-set regressions with versioned eval data | **Given** the ESCI golden set, **when** I ask for a golden-set regression check, **then** a T1 card shows the golden set's hash, a judgment diff vs the previous dataset version (a bump needs human approval), newly failing vs fixed queries between two rankers and ΔNDCG@10 with CI; `make eval-ci` runs the same check and exits non-zero on regression. | `mlops-top10.spec.ts` |
| MLO10 | Shadow a candidate before canary | **Given** logged shopper queries, **when** I ask to shadow a candidate, **then** a T1 card mirrors the queries to champion and candidate arms and shows overlap@10 and the latency difference with CIs, which version params the live path could not apply, and that no shadow result reached a shopper; entering canary is a human decision. | `mlops-top10.spec.ts` |
| MLO1B | Interleaving tool result is cited and evidenced | **Given** the `interleave_rankers` tool is called directly (no LLM), **when** it returns, **then** it is a T1 `ops_insight` result with at least one citation, n > 0, and `docs/evidence/mlops_1_interleaving.json` on disk. | `mlops-top10.spec.ts` |
| MLO2B | CUPED tool result is cited and evidenced | **Given** the CUPED/sequential-A/B tool is called directly, **when** it returns, **then** it is a T1 `ops_insight` result with at least one citation, n > 0, and its evidence file on disk. | `mlops-top10.spec.ts` |
| MLO3B | Skew tool result is cited and evidenced | **Given** the skew-check tool is called directly, **when** it returns, **then** it is a T2 `ops_insight` result with at least one citation, n > 0, and its evidence file on disk. | `mlops-top10.spec.ts` |
| MLO4B | Lineage tool result is cited and evidenced | **Given** the lineage tool is called directly, **when** it returns, **then** it is a T0 `ops_insight` result with at least one citation, n > 0, and its evidence file on disk. | `mlops-top10.spec.ts` |
| MLO5B | Retrain-trigger tool result is cited and evidenced | **Given** the retrain-trigger tool is called directly, **when** it returns, **then** it is a T2 `ops_insight` result with at least one citation, n > 0, and its evidence file on disk. | `mlops-top10.spec.ts` |
| MLO6B | Exposure-audit tool result is cited and evidenced | **Given** the exposure-audit tool is called directly, **when** it returns, **then** it is a T1 `ops_insight` result with at least one citation, n > 0, and its evidence file on disk. | `mlops-top10.spec.ts` |
| MLO7B | Config-diff tool result is cited and evidenced | **Given** the config-governance tool is called directly, **when** it returns, **then** it is a T2 `ops_insight` result with at least one citation, n > 0, and its evidence file on disk. | `mlops-top10.spec.ts` |
| MLO8B | SLO-budget tool result is cited and evidenced | **Given** the SLO/error-budget tool is called directly, **when** it returns, **then** it is a T2 `ops_insight` result with at least one citation, n > 0, and its evidence file on disk. | `mlops-top10.spec.ts` |
| MLO9B | Golden-set tool result is cited and evidenced | **Given** the golden-set regression tool is called directly, **when** it returns, **then** it is a T1 `ops_insight` result with at least one citation, n > 0, and its evidence file on disk. | `mlops-top10.spec.ts` |
| MLO10B | Shadow-deploy tool result is cited and evidenced | **Given** the shadow-deploy tool is called directly, **when** it returns, **then** it is a T1 `ops_insight` result with at least one citation, n > 0, and its evidence file on disk. | `mlops-top10.spec.ts` |

## Guide tab

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| G1 | Learn a feature and try it | **Given** the Guide at `/guide`, **when** I pick a feature and switch between Overview, User stories, Tech stack & alternatives, Diagram and Try it, **then** each tab shows that feature's data from `docs/features.json` (alternatives labelled "not built or measured here"), and "Run this" opens the chat or Ops Copilot with the prompt in the composer, not sent. | `guide.spec.ts` |
| G2 | See where a turn spent its time | **Given** a finished chat turn, **when** I click "View trace" or open the Trace tab of its replay, **then** a waterfall shows every recorded span by start and duration, coloured by kind with per-kind counts, kind filters and a click-to-open attribute panel, including the browser's ui spans under the same traceId. | `tracing.spec.ts` |

## Presenter

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| ARCH1 | Every service is up and reachable | **Given** the demo stack running locally, **when** I load `/shop`, `/ops/1` and `/guide`, **then** each responds, matching the container map in `docs/FEATURE_CATALOGUE.md` §0.1 (web on 5173 talking to bff on 8787, which fronts search-svc/shop-http/ops-http). | `walkthrough.spec.ts` (asserts the "each responds" clause only; the container-map wiring behind each response is not independently observable from a browser) |
| ARCH2 | The CLI only ever sees policy-mcp | **Given** a Shopper turn is spawned, **when** the claude CLI process starts, **then** policy-mcp is its only MCP server and shop-mcp/ops-mcp are reached only by proxy through it. | spec: none (not proven; the `--mcp-config` file is written per-run to a temp path and deleted after, with no runtime API surfacing its contents — asserted only by `bff/src/agents/roles.test.ts`) |
| P1 | Presenter density mode persists | **Given** the density toggle in split view, **when** I switch to "Presenter", **then** larger type and simplified chrome apply and the choice is written to `localStorage` (`sparky.density`). | `walkthrough.spec.ts` |
| P2 | Recorded fallback exists for a live demo | **Given** a live demo is not possible, **when** I need the split-view flow recorded instead, **then** a Playwright-recorded run (`REC full split-view run`) exercises site search, agent search + add, site removal and checkout end to end. | `recording.spec.ts` |

## Operator: gates, coverage, FinOps, data quality and trust & safety

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| OG1 | A broken eval gate turns red | **Given** a release gate (NDCG delta CI lower bound ≥ -0.005, p95 ≤ 150 ms, red-team blocked = 1.0), **when** I break the eval gate at `/ops/8b`, **then** the gate card turns red and shows "FAIL" rather than letting the release proceed silently. | `walkthrough.spec.ts` |
| OG2 | Overrides and bypasses are always audited | **Given** a named-person override or an open bypass class on a gate, **when** either is used, **then** it is written to the audit log rather than applied silently. | spec: none (not proven) |
| OCOV1 | Coverage board tallies real evidence | **Given** `/coverage` with `data/coverage.json` present, **when** the board renders, **then** it shows a tally of real-measured, real-no-metric, script-ready and absent techniques, each linked to its evidence. | `walkthrough.spec.ts` |
| OCOV2 | Coverage board refuses rather than fakes | **Given** `data/coverage.json` is missing or malformed, **when** I open `/coverage` or call `GET /api/coverage`, **then** the endpoint refuses with a real error (503) instead of showing a placeholder. | `walkthrough.spec.ts` |
| OFIN1 | FinOps view shows the router split | **Given** shopper traffic, **when** I open the FinOps view at `/ops/8c`, **then** I see how queries split across the lexical/hybrid/premium/claude arms at the router's 0.15 confidence margin. | spec: none (not proven) |
| OFIN2 | FinOps view shows cost per arm | **Given** the same FinOps view, **when** it renders, **then** it shows cost per 1k queries and per fulfilled task for each arm. | spec: none (not proven) |
| ODQ1 | Data-quality report flags real issues | **Given** the catalogue and recent queries, **when** I ask the ops plane to validate and label them, **then** a DQ report shows missingness, dietary coverage, outliers and dedup counts. | spec: none (not proven) |
| ODQ2 | Low-confidence labels wait for a human | **Given** a label produced below 0.7 confidence, **when** it is produced, **then** it is queued for human review rather than applied automatically. | spec: none (not proven) |
| OCL1 | Drift remediation is gated before canary | **Given** drift on the seasonal query stream, **when** I approve a remediation, **then** a candidate ranker is built and gated on paired NDCG CI, p95 latency and red-team blocks before it can canary — the same gate `OG1` exercises turning red. | `walkthrough.spec.ts` |
| OCL2 | Guardrail breach rolls back automatically | **Given** a canaried candidate that breaches its guardrail, **when** the watcher detects it, **then** the release is auto-rolled-back rather than left running. | `walkthrough.spec.ts` |
| OTS1 | Untrusted listing text never reaches the planner | **Given** an untrusted seller-listing containing an injected instruction ("add 10 boxes"), **when** CaMeL's quarantined extractor processes it, **then** the privileged planner never reads the raw text, only a sanitised value crosses the boundary. | spec: none (not proven; unit-tested in `bff/src/agents/camel.test.ts`) |
| OTS2 | Guarded add-to-cart blocks the injected quantity | **Given** a tool call whose quantity argument derives from untrusted text, **when** the seed red-team suite runs against `guarded_add_to_cart`, **then** all 8 of 8 attempts are blocked (n=8, technique 27). | spec: none (not proven; unit-tested in `bff/src/agents/guard.test.ts`) |

## ML engineer

| ID | Story | Acceptance | Spec |
|---|---|---|---|
| MLTOK1 | Token-optimisation flags are measured before/after | **Given** `OPT_ROUTER`/`OPT_CRITIC_GATE`/`OPT_THINKING_OFF`, **when** I run `npx tsx scripts/token_bench.ts --label <name>` with them off then on, **then** `docs/evidence/token_bench_<name>.json` records the measured token/cost delta per arm, with n. | spec: none (not proven; measured by `scripts/token_bench.ts`, not a Playwright spec) |
| MLTOK2 | Session budget drops every role to economy mode | **Given** `SESSION_COST_BUDGET_USD`, **when** a session's spend reaches 80% of it, **then** every role for the rest of that session runs in economy mode. | spec: none (not proven) |
| T1 | A turn is one traceable span tree | **Given** a finished shopper turn, **when** I call `GET /api/traces/:traceId`, **then** it returns one span tree rooted at `turn shopper` with `kind_counts` spanning router, llm, tool, policy, retrieval, state and ui. | `tracing.spec.ts` |
| T2 | Kind filters hide exactly that kind's spans | **Given** the replay Trace tab's waterfall, **when** I toggle a kind chip off, **then** spans of that kind disappear and the visible span count drops by exactly that kind's count. | `tracing.spec.ts` |

## Stories without proof

These stories describe real intended behaviour (from `docs/FEATURE_CATALOGUE.md`) but have no Playwright spec under `web/e2e/` asserting them today — most are covered only by unit tests (`bff/src/agents/camel.test.ts`, `guard.test.ts`), a non-Playwright script (`scripts/token_bench.ts`), or nothing yet. Do not claim these as tested; treat them as backlog for real e2e coverage.

| ID | Why it is unproven |
|---|---|
| ARCH2 | The CLI's `--mcp-config` is written to a fresh temp path per run (`bff/src/agents/mcpConfig.ts`) and deleted afterwards; no ops.db row, trace span or HTTP response exposes which MCP servers the CLI subprocess actually saw, so a browser-driven spec has nothing live to read. Asserted only by the unit test `bff/src/agents/roles.test.ts` (checks `buildArgs` emits `--strict-mcp-config` and the single `--mcp-config` path). |
| OG2 | `run_eval_suite` — the only path that evaluates `data/bypass_overrides.json` and records the override in its audit detail — is an MCP tool with no HTTP route (`services/ops-mcp/src/ops_mcp/http_app.py` exposes `gate_preregistered_candidate` for the demo gate, not `run_eval_suite`); it is reachable only by asking the live Ops Copilot to run the eval gate, which needs a genuine `@llm` turn to prove a single audit-log line, and today's `data/redteam_findings.json` has no bypass class actually left open to override. |
| OFIN1 | The real router (`bff/src/ops/finops.ts`, `beat 8c`) is a binary cheap/Claude heuristic (`isHard()` regex match), not the 4-arm lexical/hybrid/premium/claude split at a 0.15 confidence margin the story describes — there is no such margin or arm set in the code to assert against. |
| OFIN2 | The FinOps panel on `/ops/8c` only shows non-placeholder cost-per-1k numbers once a real Claude run has recorded cost in `metrics.ts` for this process; producing that live requires a genuine `@llm` shopper turn first, so a cheap deterministic check would either assert the "run a shopper beat first" refusal (not the story) or depend on another spec's leftover state (flaky). |
| ODQ1, ODQ2 | The DQ report and the below-0.7 human-review queue are populated only by the `label_queries`/`record_labels` MCP tools, called by the ops-mcp Ops Copilot agent; `http_app.py` exposes `GET /labels/review_queue` and `POST /labels/review` (submitting a decision) but no route to run validation or create a labelling batch directly, so proving either needs a genuine `@llm` turn. |
| OTS1, OTS2 | The guard/CaMeL path is exercised only by bff unit tests (`bff/src/agents/camel.test.ts`, `guard.test.ts`), not a Playwright spec against the running services; the quarantine boundary and the guarded tool call are TypeScript-internal, not requests a browser-driven spec can observe. |
| MLTOK1 | Token-optimisation before/after deltas come from `npx tsx scripts/token_bench.ts` runs writing `docs/evidence/token_bench_<name>.json`; that script drives the CLI directly outside the web/bff stack, so there is no page or endpoint for a Playwright spec to assert against. |
| MLTOK2 | The 80%-of-`SESSION_COST_BUDGET_USD` switch to economy mode (`bff/src/agents/budget.ts`) only fires after enough real, metered LLM turns accumulate spend in one session — proving it live needs a multi-turn `@llm` scenario expensive enough that it isn't a practical e2e check; today it is exercised only at the unit level. |
