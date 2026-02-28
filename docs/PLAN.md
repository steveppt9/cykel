# Cykel — Project Plan

> Open-source, privacy-first, on-device menstrual cycle tracker.
> All data encrypted at rest. No server. No sync. No telemetry. Your body, your data.

---

## Product Vision

A cycle tracker that **women can trust**. Built in Rust for memory safety and performance. Encrypted with a passphrase that never leaves the device. Open source so anyone can verify the claims. Designed for 18-45 year old women with basic tech experience — it should feel as natural as scrolling TikTok.

## Threat Model

| Threat | Mitigation |
|---|---|
| Lost/stolen device | All data AES-256-GCM encrypted at rest. No plaintext ever written to disk. |
| Third party accessing app | Passphrase-locked. Auto-lock after inactivity. Optional wipe after failed attempts. |
| Forensic analysis of device | Encryption key derived from passphrase via Argon2id. No key stored on disk. Memory zeroed on lock. |
| Compelled biometric unlock | Biometric unlock OFF by default (opt-in with warning). |
| Network exfiltration | Zero network calls. No analytics. No permissions beyond local file storage. |

## Architecture

```
┌─────────────────────────────────────┐
│           Frontend (Web)            │
│  HTML / CSS / JS — Tauri v2 shell   │
│  Calendar UI, Day Logging, Settings │
└──────────────┬──────────────────────┘
               │ Tauri Commands (IPC)
┌──────────────▼──────────────────────┐
│           Rust Core                 │
│                                     │
│  commands.rs  — Tauri command API   │
│  crypto.rs    — Argon2id + AES-GCM  │
│  storage.rs   — Encrypted file I/O  │
│  models.rs    — Data types          │
│  prediction.rs — Cycle predictions  │
└─────────────────────────────────────┘
               │
┌──────────────▼──────────────────────┐
│     Encrypted Data File (.cykel)    │
│     Single blob, AES-256-GCM       │
│     On-device only, no sync        │
└─────────────────────────────────────┘
```

## Encryption Design

1. **First launch**: User creates a passphrase
2. **Key derivation**: Passphrase → Argon2id (memory-hard, time-hard) → 256-bit key
3. **Encryption**: All app data serialized to JSON → encrypted with AES-256-GCM → written as single file
4. **No oracle**: Wrong passphrase produces garbage. We validate by checking for a known magic byte header in the decrypted plaintext. Attackers get no signal about partial correctness.
5. **Lock**: Key material zeroed from memory via `zeroize` crate
6. **No recovery**: Lost passphrase = lost data. This is a feature, not a bug.

## Data Model (v1)

### Cycle
| Field | Type | Description |
|---|---|---|
| id | UUID | Unique identifier |
| start_date | Date | First day of period |
| end_date | Option\<Date\> | Last day (null if current) |

### DayLog
| Field | Type | Description |
|---|---|---|
| date | Date | Calendar date |
| flow_level | Enum | None / Light / Medium / Heavy |
| notes | String | Optional freetext |

### Symptom
| Field | Type | Description |
|---|---|---|
| date | Date | Calendar date |
| symptom_type | Enum | Cramps, Headache, MoodLow, MoodHigh, Fatigue, Bloating, BreastTenderness, Acne |
| severity | u8 | 1 (mild) to 3 (severe) |

### Prediction
| Field | Type | Description |
|---|---|---|
| predicted_start | Date | Expected next period start |
| predicted_end | Date | Expected next period end |
| confidence | f32 | 0.1 to 0.95 |

**Not tracked in v1**: Sexual activity, contraception, temperature, cervical mucus. These are high-sensitivity data points with marginal predictive value for basic cycle tracking. Can revisit for v2.

## Prediction Algorithm (v1)

Simple and transparent — no black box:

```
average_cycle_length = mean(last 6 cycle lengths)
average_period_length = mean(last 6 period lengths)
predicted_start = last_period_start + average_cycle_length
predicted_end = predicted_start + average_period_length
confidence = clamp(1.0 - (std_dev / average_cycle_length), 0.1, 0.95)
```

Minimum 2 logged cycles before predictions are shown. Confidence displayed to user as a simple indicator (not a percentage — avoids false precision).

## Frontend Design

### Screens
1. **Setup** — Passphrase creation (first launch)
2. **Unlock** — Passphrase entry
3. **Calendar** — Month view with flow/symptom indicators. Tap day to log. Swipe for months.
4. **Day Log** — Flow level (4 tap targets), symptom chips (toggle), notes field
5. **Settings** — Auto-lock timeout, wipe data, about

### Design Direction
- **Vibe**: Flo meets Cash App meets a candle. Minimal, warm, confident.
- **No**: Pink-everything, medical-clinical aesthetic, gamification, streaks, guilt
- **Yes**: Warm neutrals, one accent color, generous whitespace, smooth motion

### Design Tokens
| Token | Value |
|---|---|
| Background | `#FFF8F0` (warm off-white) |
| Text | `#2D2A26` (charcoal) |
| Accent | `#C4654A` (terracotta) |
| Secondary | `#A8B5A0` (sage) |
| Tertiary | `#D4A0A0` (muted rose) |
| Radius | 16px |
| Motion | 200ms ease-out |
| Font | System stack (SF Pro / Roboto / sans-serif) |

### UX Principles
1. **No onboarding walls** — passphrase, then you're in
2. **Calendar-first** — the mental model is a calendar
3. **One-hand operation** — logging takes <5 seconds
4. **No dark patterns** — no streaks, no guilt, no gamification
5. **Transparent predictions** — show the math
6. **Panic features** — quick-lock gesture, optional decoy mode (v2)

## Tech Stack

| Layer | Technology |
|---|---|
| Core logic | Rust |
| Encryption | `argon2` + `aes-gcm` crates |
| Serialization | `serde` + `serde_json` |
| Date handling | `chrono` |
| Memory safety | `zeroize` |
| App shell | Tauri v2 |
| Frontend | Vanilla HTML/CSS/JS (framework optional later) |
| Build | Cargo + Tauri CLI |

## Build Phases

### Phase 1: Scaffold (current)
- [ ] Install Rust toolchain
- [ ] Initialize Tauri v2 project
- [ ] Implement crypto module (Argon2id + AES-256-GCM)
- [ ] Implement data models
- [ ] Implement encrypted storage
- [ ] Implement Tauri commands
- [ ] Build setup + unlock screens
- [ ] Build calendar view
- [ ] Build day logging

### Phase 2: Polish
- [ ] Prediction engine
- [ ] Auto-lock timer
- [ ] Wipe after failed attempts
- [ ] Animations and transitions
- [ ] Accessibility audit
- [ ] Mobile-optimized touch targets

### Phase 3: Harden
- [ ] Security audit of crypto implementation
- [ ] Fuzzing the encryption layer
- [ ] Memory analysis (no plaintext leaks)
- [ ] Build for iOS + Android via Tauri mobile

### Phase 4: Ship
- [ ] App store metadata
- [ ] Landing page
- [ ] Open source repo setup (LICENSE, CONTRIBUTING, etc.)

---

*Your body, your data, your device.*
