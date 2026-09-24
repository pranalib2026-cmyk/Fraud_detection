# Dataset profile (auto-generated)

Generated: 2026-09-22T16:37:08.923Z
Source: `data/raw/HHGOA_IEEE`

Produced by `tools/inspect-dataset.mjs` directly from the shipped CSVs. Nothing here is
hand-entered, so it can be regenerated and re-verified at any time:

```bash
node tools/inspect-dataset.mjs
```

## Files

| File | Rows | Columns |
|---|---|---|
| transactions.csv | 590742 | 397 |
| identity.csv | 144432 | 41 |
| closed_cases_history.csv | 5565 | 15 |
| case_pack.csv | 20 | 8 |

## transactions.csv

| Fact | Value |
|---|---|
| Rows | 590742 |
| Columns | 397 |
| Distinct `customer_id` | 13553 |
| Distinct `card1` | 13553 |
| Distinct (customer_id, card1) pairs | 13553 |
| Customers with more than one card1 | 0 |
| card1 values shared by more than one customer_id | 0 |
| `ts` range | 2016-07-02 00:02:21 .. 2016-12-31 23:58:54 |
| `TransactionID` range | 3000001 .. 3590742 |
| Total amount (USD) | 79797405.56 |
| Largest amount (USD) | 31937.38 |
| Distinct `addr1` | 333 |
| Distinct `addr2` | 75 |
| `risk_score` empty values | 0 |
| `risk_score` min / max | 0.01 / 0.99 |
| Referenced txns resolved from the raw file | 14975 |
| Referenced txns not found | 0 |

### ProductCD

| Value | Count |
|---|---|
| `W` | 439670 |
| `C` | 68721 |
| `R` | 37699 |
| `H` | 33024 |
| `S` | 11628 |

### channel

| Value | Count |
|---|---|
| `in_person` | 439670 |
| `online` | 151072 |

### risk_score deciles

- `0.0-0.1`: 249671
- `0.1-0.2`: 167229
- `0.2-0.3`: 81288
- `0.3-0.4`: 35870
- `0.4-0.5`: 16725
- `0.5-0.6`: 11513
- `0.6-0.7`: 10558
- `0.7-0.8`: 9607
- `0.8-0.9`: 6516
- `0.9-1.0`: 1765

### addr2 (billing country code), top values

| addr2 | Count |
|---|---|
| `87.0` | 520643 |
| `` | 65739 |
| `60.0` | 3087 |
| `96.0` | 642 |
| `32.0` | 91 |
| `65.0` | 82 |

## identity.csv

| Fact | Value |
|---|---|
| Rows | 144432 |
| Columns | 41 |
| Distinct DeviceInfo strings | 1787 |

### id_15 (device New / Found)

| Value | Count |
|---|---|
| `Found` | 67773 |
| `New` | 61754 |
| `Unknown` | 11653 |
| `` | 3252 |

### id_23 (proxy)

| Value | Count |
|---|---|
| `` | 139144 |
| `IP_PROXY:TRANSPARENT` | 3492 |
| `IP_PROXY:ANONYMOUS` | 1185 |
| `IP_PROXY:HIDDEN` | 611 |

### DeviceType

| Value | Count |
|---|---|
| `desktop` | 85204 |
| `mobile` | 55801 |
| `` | 3427 |

### id_30 (OS), top 15

| Value | Count |
|---|---|
| `` | 66693 |
| `Windows 10` | 21167 |
| `Windows 7` | 13117 |
| `iOS 11.2.1` | 3739 |
| `iOS 11.1.2` | 3700 |
| `Android 7.0` | 2990 |
| `Mac OS X 10_12_6` | 2559 |
| `Mac OS X 10_11_6` | 2348 |
| `iOS 11.3.0` | 2016 |
| `Windows 8.1` | 1914 |
| `Mac OS X 10_10_5` | 1651 |
| `iOS 11.2.6` | 1647 |
| `iOS 10.3.3` | 1558 |
| `Mac OS X 10_13_2` | 1423 |
| `Mac OS X 10_13_1` | 1211 |

### id_31 (browser), top 15

| Value | Count |
|---|---|
| `chrome 63.0` | 22012 |
| `mobile safari 11.0` | 13439 |
| `mobile safari generic` | 11481 |
| `ie 11.0 for desktop` | 9039 |
| `safari generic` | 8197 |
| `chrome 62.0` | 7182 |
| `chrome 65.0` | 6873 |
| `chrome 64.0` | 6719 |
| `chrome 63.0 for android` | 5809 |
| `chrome generic` | 4779 |
| `chrome 66.0` | 4264 |
| `edge 16.0` | 4189 |
| `` | 3955 |
| `chrome 64.0 for android` | 3476 |
| `chrome 65.0 for android` | 3336 |

### DeviceInfo, top 20

| Value | Count |
|---|---|
| `Windows` | 47741 |
| `` | 25580 |
| `iOS Device` | 19805 |
| `MacOS` | 12579 |
| `Trident/7.0` | 7446 |
| `rv:11.0` | 1904 |
| `rv:57.0` | 962 |
| `SM-J700M Build/MMB29K` | 549 |
| `SM-G610M Build/MMB29K` | 461 |
| `SM-G935F Build/NRD90M` | 448 |
| `SM-G531H Build/LMY48B` | 410 |
| `rv:59.0` | 362 |
| `SM-G955U Build/NRD90M` | 329 |
| `SM-G532M Build/MMB29T` | 316 |
| `ALE-L23 Build/HuaweiALE-L23` | 312 |
| `SM-G950U Build/NRD90M` | 290 |
| `SM-G930V Build/NRD90M` | 275 |
| `rv:58.0` | 269 |
| `rv:52.0` | 256 |
| `SAMSUNG` | 235 |

## closed_cases_history.csv

| Fact | Value |
|---|---|
| Rows | 5565 |
| Opened / closed range | 2016-07-02 07:17:26 .. 2016-11-06 23:39:58 |
| Cases naming connected cards | 4 |
| Cases with more than one transaction | 2107 |
| Total exposure (USD) | 2072387.77 |
| Largest exposure (USD) | 35031.56 |

### outcome

| Value | Count |
|---|---|
| `confirmed_fraud` | 4665 |
| `cleared` | 900 |

### pattern

| Value | Count |
|---|---|
| `card_not_present_fraud` | 1404 |
| `account_takeover` | 1205 |
| `card_not_present_new_device` | 1076 |
| `out_of_region_use` | 955 |
| `none` | 900 |
| `card_testing` | 16 |
| `undocumented` | 9 |

### report_filed

| Value | Count |
|---|---|
| `No` | 5168 |
| `Yes` | 397 |

### actions_taken (split on \|)

| Action | Count |
|---|---|
| `CREATE_CASE` | 4665 |
| `BLOCK_CARD` | 4665 |
| `VERIFY_WITH_CUSTOMER` | 900 |
| `CLOSE_NO_FRAUD` | 900 |
| `FILE_REPORT` | 397 |

## case_pack.csv

| Fact | Value |
|---|---|
| Rows | 20 |
| Distinct customers | 20 |
| Distinct cards | 20 |

### trigger_type

| Value | Count |
|---|---|
| `risk_score` | 11 |
| `customer_report` | 8 |
| `analyst_request` | 1 |

## Card identifier derivation (C#####-K#)

The case pack and closed-case history address cards as `C01234-K1`. Transactions carry
`customer_id` (`C01234`) and the numeric `card1`..`card6` issuer features only, so the card key
has to be reconstructed from evidence instead of assumed. The 14,975 (card_id, txn) pairs in
`closed_cases_history.csv` plus the 20 case-pack pairs are the ground truth for that test.

Candidate key fit (collisions = one signature, two different card ids):

| Candidate key | Collisions | Distinct signatures | Labelled cards |
|---|---|---|---|
| `card1` | 36 | 1896 | 1917 |
| `customer_id` | 36 | 1896 | 1917 |
| `customer_id+card1` | 36 | 1896 | 1917 |
| `card1+card4` | 8 | 1913 | 1917 |
| `card1+card6` | 0 | 1917 | 1917 |
| `card1+card4+card6` | 0 | 1917 | 1917 |
| `customer_id+card1+card6` | 0 | 1917 | 1917 |

Chosen key: **`card1+card6`** (conflicts: 0,
labelled cards: 1917,
signatures with an empty card6: 18).

### Which rule orders the -K# suffix?

21 customers in the labelled evidence hold more than one
card, so only they can reveal the ordering. Best fit: **card6 asc = 21/21**.

| Ordering hypothesis | Exact fit |
|---|---|
| first_ts asc | 4/21 |
| first_ts desc | 17/21 |
| last_ts asc | 19/21 |
| last_ts desc | 2/21 |
| n_txns asc | 17/21 |
| n_txns desc | 4/21 |
| total_amt asc | 17/21 |
| total_amt desc | 4/21 |
| card6 asc | 21/21 |
| card6 desc | 0/21 |
| card1 asc | 4/21 |
| card1 desc | 4/21 |

### Multi-card customer detail (first 6)

**C04597**

| card_id | signature (card1\|card6) | K | txns | total USD | first ts | last ts | products |
|---|---|---|---|---|---|---|---|
| C04597-K2 | 22904|debit | 2 | 2054 | 79705.82 | 2016-07-02 00:56:36 | 2016-12-29 22:23:49 | C |
| C04597-K1 | 22904| | 1 | 8 | 351.8 | 2016-09-28 15:49:36 | 2016-12-07 02:13:37 | C |

**C07212**

| card_id | signature (card1\|card6) | K | txns | total USD | first ts | last ts | products |
|---|---|---|---|---|---|---|---|
| C07212-K2 | 15876|credit | 2 | 2518 | 518759.4 | 2016-07-02 01:40:00 | 2016-12-29 21:05:30 | W/R/H/C/S |
| C07212-K1 | 15876| | 1 | 4 | 1311.73 | 2016-09-28 15:10:55 | 2016-12-07 02:54:34 | W |

**C02000**

| card_id | signature (card1\|card6) | K | txns | total USD | first ts | last ts | products |
|---|---|---|---|---|---|---|---|
| C02000-K2 | 16800|debit | 2 | 2597 | 278544.22 | 2016-07-04 01:02:50 | 2016-12-31 22:10:50 | W/H/R/C/S |
| C02000-K1 | 16800| | 1 | 7 | 441.69 | 2016-10-01 14:25:51 | 2016-12-10 01:30:05 | W |

**C02575**

| card_id | signature (card1\|card6) | K | txns | total USD | first ts | last ts | products |
|---|---|---|---|---|---|---|---|
| C02575-K2 | 21514|debit | 2 | 212 | 37562.21 | 2016-07-02 12:01:01 | 2016-12-30 18:14:07 | W/R/H |
| C02575-K1 | 21514| | 1 | 1 | 445.06 | 2016-09-29 16:59:38 | 2016-09-29 16:59:38 | W |

**C02716**

| card_id | signature (card1\|card6) | K | txns | total USD | first ts | last ts | products |
|---|---|---|---|---|---|---|---|
| C02716-K2 | 18652|credit | 2 | 5155 | 1325499.72 | 2016-07-05 00:52:58 | 2016-12-31 23:35:59 | W/S/H/R/C |
| C02716-K1 | 18652| | 1 | 17 | 3624.51 | 2016-10-02 15:35:36 | 2016-12-11 03:23:09 | W/C |

**C09800**

| card_id | signature (card1\|card6) | K | txns | total USD | first ts | last ts | products |
|---|---|---|---|---|---|---|---|
| C09800-K2 | 12563|debit | 2 | 5110 | 617226.45 | 2016-07-06 01:13:08 | 2016-12-31 23:06:01 | W/H/S/R/C |
| C09800-K1 | 12563| | 1 | 19 | 1972.51 | 2016-10-03 13:44:06 | 2016-12-12 02:31:09 | W |


## Case-pack transaction resolution

| case | trigger | flagged txn | card | customer match | risk match | channel | amount | addr1 | risk | device id_15 |
|---|---|---|---|---|---|---|---|---|---|---|
| HHG-001 | risk_score | 3514030 | C12382-K1 | true | true | in_person | 77.07 | 444.0 | 0.61 | no identity record |
| HHG-002 | risk_score | 3478782 | C11891-K1 | true | true | online | 292.36 |  | 0.79 | no identity record |
| HHG-003 | customer_report | 3530164 | C08623-K2 | true | n/a | in_person | 49 | 330.0 | 0.40 | no identity record |
| HHG-004 | customer_report | 3583227 | C08106-K1 | true | n/a | online | 128.33 |  | 0.34 | New |
| HHG-005 | risk_score | 3523199 | C02923-K1 | true | true | online | 100.07 | 330.0 | 0.54 | New |
| HHG-006 | customer_report | 3476682 | C07297-K1 | true | n/a | online | 482.12 | 264.0 | 0.25 | New |
| HHG-007 | risk_score | 3514948 | C09933-K2 | true | true | in_person | 111.92 | 264.0 | 0.87 | no identity record |
| HHG-008 | customer_report | 3558054 | C13171-K2 | true | n/a | online | 55.68 |  | 0.38 | Found |
| HHG-009 | customer_report | 3581141 | C08299-K1 | true | n/a | online | 30.02 | 203.0 | 0.28 | Found |
| HHG-010 | risk_score | 3506725 | C10434-K1 | true | true | online | 1000.03 | 469.0 | 0.90 | New |
| HHG-011 | customer_report | 3583368 | C11923-K2 | true | n/a | online | 131.3 |  | 0.39 | New |
| HHG-012 | risk_score | 3553342 | C05876-K2 | true | true | in_person | 30.91 | 494.0 | 0.55 | no identity record |
| HHG-013 | risk_score | 3526826 | C07671-K2 | true | true | online | 35.66 |  | 0.76 | New |
| HHG-014 | analyst_request | 3478561 | C13487-K1 | true | n/a | online | 74.96 | 191.0 | 0.05 | New |
| HHG-015 | risk_score | 3464869 | C03042-K1 | true | true | online | 599.94 | 327.0 | 0.77 | New |
| HHG-016 | customer_report | 3534820 | C09988-K1 | true | n/a | online | 59.67 |  | 0.37 | New |
| HHG-017 | risk_score | 3450629 | C04570-K1 | true | true | online | 100.09 | 204.0 | 0.57 | Found |
| HHG-018 | customer_report | 3491361 | C02354-K2 | true | n/a | in_person | 39.08 | 126.0 | 0.48 | no identity record |
| HHG-019 | risk_score | 3503878 | C07987-K2 | true | true | online | 99.92 | 264.0 | 0.90 | New |
| HHG-020 | risk_score | 3509359 | C12265-K2 | true | true | online | 125.08 | 264.0 | 0.52 | New |
