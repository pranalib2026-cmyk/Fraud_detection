# Dataset schema and canonical mapping

Source of truth, in priority order:

1. The supplied dataset `README.md` (`data/raw/HHGOA_IEEE/README.md`) — file list,
   column groups, added columns, closed-case columns, case-pack columns, fraud policy
   and answer format.
2. The actual CSV headers and values (`tools/inspect-dataset.mjs` -> `docs/data_profile.md`).
3. This document, which maps source fields to the internal canonical model.

Every mapping below is either **explicit in the README** or **derived from the data and
validated against labelled evidence**. Nothing is assumed silently; derived mappings are
recorded in `docs/assumptions.md` with their validation evidence.

## 1. Source files (as shipped)

| File | Rows (measured) | Columns | Notes |
|---|---|---|---|
| `transactions.csv` | 590,742 | 397 | 393 original Vesta columns + `customer_id`, `ts`, `channel`, `risk_score` |
| `identity.csv` | 144,432 | 41 | online transactions only, joins on `TransactionID` |
| `closed_cases_history.csv` | 5,565 | 16 | 4,665 `confirmed_fraud`, 900 `cleared`, July-October |
| `case_pack.csv` | 20 | 8 | the benchmark alerts, November-December |

Measured distributions (see `docs/data_profile.md` for the full generated profile):
`ProductCD` W 439,670 / C 68,721 / R 37,699 / H 33,024 / S 11,628; `channel`
in_person 439,670 / online 151,072 (note `ProductCD=W` is `in_person`, exactly as the
README states); `risk_score` range 0.01-0.99 with no empties; `ts` range
2016-07-02 00:02:21 to 2016-12-31 23:58:54; `TransactionID` range 3000001-3590742.

## 2. Canonical concepts and their source columns

| Canonical concept | Internal id | Source | Mapping |
|---|---|---|---|
| Customer | `customer_id` (`C#####`) | `transactions.customer_id` | taken verbatim; README documents it as derived from the card issuer field |
| Card | `card_id` (`C#####-K#`) | derived (see §3) | labelled evidence gives the display id; transactions give the key |
| Card (internal key) | `card_key` = `card1 + '|' + card6` | `transactions.card1`, `transactions.card6` | **derived, validated** on all 14,975 labelled (card_id, txn) pairs with 0 collisions |
| Transaction | `TransactionID` | `transactions.TransactionID` | verbatim; 590,742 unique values |
| Transaction time | `ts` | `transactions.ts` | verbatim `YYYY-MM-DD HH:MM:SS`; `TransactionDT` retained as a raw feature |
| Amount | `amount_usd` | `transactions.TransactionAmt` | verbatim, USD |
| Channel | `channel` | `transactions.channel` | `in_person` or `online`; consistent with `ProductCD=W` |
| Product code | `product_cd` | `transactions.ProductCD` | `W`/`C`/`H`/`R`/`S` |
| Risk score | `risk_score` | `transactions.risk_score` | **input signal only, never a verdict** |
| Billing region | `region` | `transactions.addr1` | anonymised code, e.g. `444.0` |
| Billing country | `country` | `transactions.addr2` | code; `87` documented as the home country |
| Purchaser email domain | `email_domain` | `transactions.P_emaildomain` | verbatim; `R_emaildomain` (recipient) also loaded |
| Device profile | `device_id` | `identity.DeviceInfo` + `id_30` + `id_31` + `id_33` | README: "DeviceInfo + OS + browser + screen" |
| Device type | `device_type` | `identity.DeviceType` | `mobile` / `desktop` |
| Device novelty | `device_new_or_found` | `identity.id_15` | measured: Found 67,773 / New 61,754 / Unknown 11,653 / empty 3,252 |
| Proxy signal | `proxy` | `identity.id_23` | measured: empty 139,144 / TRANSPARENT 3,492 / ANONYMOUS 1,185 / HIDDEN 611 |
| Identity record | `identity` | `identity.*` | online transactions only; 8,418 of the labelled evidence transactions have one |
| Closed case | `case_id` (`CC-####`) | `closed_cases_history.*` | labelled precedent: `outcome`, `pattern`, `actions_taken`, `report_filed`, `analyst_notes` |
| Case-pack alert | `case_id` (`HHG-###`) | `case_pack.csv` | benchmark trigger, flagged txn, card, customer, risk score |
| Vesta engineered features | `v1..v339`, `c1..c14`, `d1..d15`, `m1..m9` | `transactions.*` | nameless features, used as signals only |

## 3. Card identifier derivation (evidence-validated)

The case pack and closed-case history address cards as `C01234-K1`; transactions carry
`customer_id` plus the numeric issuer features `card1`-`card6`. Two findings, both measured
by `tools/inspect-dataset.mjs` and reproducible:

**Key rule - `card1 + card6`.** Over the 14,975 labelled (card_id, txn) pairs covering 1,917
distinct cards, `card1 + card6` produces 1,917 distinct signatures with **0 collisions**,
while `card1` alone produces 36 collisions and `customer_id + card1` the same 36.
`card1 + card4`, `card1 + card4 + card6` and `card1..card6` also separate the cards, but
`card1 + card6` is the simplest rule with a perfect fit. Full table:
`docs/data_profile.md` -> "Candidate key fit".

**K-index rule - order by `card6`.** 21 customers in the labelled evidence hold two cards.
Sorting each customer's cards by `card6` ascending (`''` unknown < `credit` < `debit`)
reproduces every observed K index: **21/21 exact fit**. Competing orderings fit far worse
(first `ts` ascending 4/21, last `ts` ascending 19/21, transaction count ascending 17/21,
amount ascending 17/21). Because it is inferred from 21 observations it is treated strictly
as a *label-derivation* rule, never as evidence about fraud:

* when labelled evidence names the card, that label always wins;
* when a card is reached only by traversal, its label is derived by the rule and recorded
  with `label_source: "derived_card6_rank"`;
* both paths are auditable per case, and any disagreement is logged as a mapping conflict.

## 4. Graph schema (as loaded)

Vertices: `Customer`, `Card`, `Transaction`, `DeviceProfile`, `EmailDomain`,
`BillingRegion`, `ClosedCase`, plus the agent's own `InvestigationCase`, `Evidence`,
`Hypothesis`, `Decision`, `Action`, and `AuditEvent`.

Edges: `OWNS` (Customer->Card), `MADE` (Card->Transaction), `FROM_DEVICE`
(Transaction->DeviceProfile, online only), `PURCHASER_EMAIL` (Transaction->EmailDomain),
`BILLED_IN` (Transaction->BillingRegion), `NEXT` (Transaction->Transaction within a card),
`INVOLVES` (ClosedCase->Transaction), `ON_CARD` (ClosedCase->Card), `CONNECTED_TO`
(ClosedCase->Card) - the README's suggested schema - plus `SUPPORTS`/`CONTRADICTS`
(Evidence->Hypothesis) and `ABOUT` (Evidence->Transaction/Card/DeviceProfile) used by the
investigation engine. See `docs/tigergraph-schema.md` and `gsql/1-schema.gsql`.

## 5. What is deliberately *not* mapped

* There is **no fraud label** for case-pack transactions. `risk_score` is an input.
* `V*`, `C*`, `D*`, `M*`, `id_01`-`id_11` are nameless model features. They are used as
  unnamed signals and described as such in evidence text; the system never claims to know
  what `V127` means.
* The dataset has no merchant column, so no merchant entity is invented.
* `addr1`/`addr2` are anonymised codes; no geo-location is inferred beyond the documented
  `addr2 = 87` home-country note.
* No currency column exists; amounts are USD per the README.
* Regulatory documents are referenced by URL in the README. Their content is **not**
  fabricated here: the local corpus ships the dataset's own policy and pattern text, and the
  loader ingests any additional documents placed in `corpus/`.

