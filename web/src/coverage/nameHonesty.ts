/**
 * Name honesty: where what was BUILT differs from the playbook technique NAME.
 *
 * The board keeps the playbook's name (it is the index into the playbook) and shows what was
 * actually built next to it. Each entry is a paraphrase of evidence that is already in
 * data/coverage.json for that row (a caveat or a code-ref note), and `evidence` quotes which.
 * No entry adds a claim that is not in the data. Checked against every real-* row's code refs.
 */
export interface BuiltAs {
  builtAs: string;
  notBuilt: string;
  evidence: string;
}

export const BUILT_AS: Record<number, BuiltAs> = {
  3: {
    builtAs: "DP histogram release of query logs (Laplace / analytic-Gaussian mechanism)",
    notBuilt: "No DP-trained generative model",
    evidence: "code ref dp_query_logs.py:dp_histogram — note \"Laplace / analytic-Gaussian mechanism\"",
  },
  9: {
    builtAs: "Text-only late interaction (ColBERT-style MaxSim) on the existing bge-small encoder",
    notBuilt: "The ColPali VISION variant, and a trained ColBERT checkpoint, were not run and are absent",
    evidence: "caveat beginning \"SCOPE: the playbook's technique 9 is ColPali VISUAL retrieval\"",
  },
  10: {
    builtAs: "networkx product graph + rules-first query router",
    notBuilt: "No LLM-extracted graph or community summaries; graph edges come from ESCI labels",
    evidence: "code ref notes \"networkx product graph + traversal\", \"rules-first query router\" and the caveat on ESCI-derived edges",
  },
  16: {
    builtAs: "Budgeted greedy coordinate search over the ranking config space",
    notBuilt: "No LLM proposer drives the search",
    evidence: "code ref mle_search.py:search — note \"budgeted search over the ranking config space\"",
  },
  19: {
    builtAs: "Cohen's kappa + Wilson CI against ESCI qrels",
    notBuilt: "No Rogan-Gladen prevalence correction; no human gold set exists",
    evidence: "caveat beginning \"Calibration here means agreement with ESCI qrels\"",
  },
  29: {
    builtAs: "OTel GenAI tracing + a LEXICAL online judge",
    notBuilt: "The judge is not an LLM",
    evidence: "caveat beginning \"a lexical judge cannot see semantics\"",
  },
  34: {
    builtAs: "Signing and verification with a LOCAL demo key (data/ops_keys/)",
    notBuilt: "Not Sigstore keyless signing bound to a CI identity; no admission controller",
    evidence: "caveat beginning \"This is a LOCAL demo key\"",
  },
};
