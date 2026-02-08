# PostHog Bot Tagger

A Node.js utility designed to clean up your PostHog analytics by identifying bots, scrapers, and datacenter traffic. It automatically merges recognized "Good Bots" into human-readable person records while maintaining detailed IP intelligence for every profile.

## Features

-   **Multi-Source Bot Detection**: Data is fetched live from these sources at startup to ensure your bot detection stays up-to-date without needing manual updates.
    - Sources:
        - [Hexydec IP Ranges](https://github.com/hexydec/ip-ranges) (Daily): Robust Crawler and Datacenter IP ranges.
        - [GoodBots](https://github.com/AnTheMaker/GoodBots) (Daily): Verified Good Bot IP lists by provider.
        - [Avastel Proxy Lists](https://github.com/antoinevastel/avastel-bot-ips-lists) (Daily): High-confidence residential proxy detection.
        - [Firehol Blocklist](https://github.com/firehol/blocklist-ipsets) (Daily): Level 1 blocklist for malicious traffic.
        - [ShadowWhisperer IPs](https://github.com/ShadowWhisperer/IPs) (Hourly): Comprehensive lists for BruteForce, Malware, and Scanners.
        - [PostHog Bot IPs](https://raw.githubusercontent.com/PostHog/posthog/refs/heads/master/nodejs/assets/bot-ips.txt): Official PostHog bot filter list.
        - **Official Provider Lists**: Direct JSON feeds from Google, Microsoft (Bing), OpenAI, and Anthropic.
    - Rationale:
        - Posthog does not allow retroactive updates to events, so if you have a "bot problem" and you fix it with a Transformation, only future events will be affected.
        - This means that when reporting on e.g. traffic patterns now vs. last year, it will appear that your project's popularity has dropped!
        - Instead, you can add these bot-tagged "persons" to a "Bot" Cohort in Posthog, and create a "Human" Cohort (all persons not in the Bot Cohort) to use in all your insights for actual humans both past and future.
-   **Intelligent Person Merging**: Automatically merges session data from recognized good bots into a single human-readable Person ID.
    - Examples:
        - Googlebot
        - Bingbot
        - Sogou web spider
        - PTST
    - Rationale:
        - If you just want to drop bots, that's fine. But if not, you can now see the bots moving around and interacting with your site as "returning" persons, just like humans.
-   **Datacenter Tagging**: Identifies and tags persons with IPs from major cloud providers.
    - Examples:
        - Amazon AWS
        - Google Cloud Platform
    - Rationale:
        - Posthog extracts location data for persons and events based on IPs.
        - Even real-human traffic is often routed through datacenters nowadays.
        - This means you may see e.g. "Ashburn, Virginia" at the top of your "Top 10 Cities" insight, which is a lie.
        - Therefore, the GeoIP data from datacenters is literally **worse than no data**.
        - With datacenter IPs tagged, you can handle this however you like with native PostHog filters!
-   **Person IP Tracking**:
    -   `$initial_ip`: Records the first-ever seen IP.
    -   `$latest_ip`: Tracks the most recent IP if it differs from the initial one.
    -   `$latest_nonproxy_ip`: Tracks the most recent IP address that is **not** identified as a datacenter or bot/proxy. Useful for finding the real residential location of users who sometimes use VPNs.
    -   Rationale:
        - Posthog processes IP data into GeoIP data for Persons, but then drops the IP data.
        - This makes sense if you are in the EU or otherwise need GDPR compliance
        - Though IP data is still stored on the Events themselves by default.
        - Querying events to get a person's IP is inefficient and not well supported with UI filters.
        - Person Properties already include `$initial_user_agent` -- this extends that pattern to IP addresses.


## 🛠 Setup

### Requirements
- Node.js 18+
- A PostHog Project API Key (starts with `phc_`) and a Personal API Key (starts with `phx_`) in your `.env`.

### Installation
1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```

### Configuration
Create a `.env` file in the root directory:
```env
POSTHOG_API_KEY=phx_your_personal_key
POSTHOG_PROJECT_ID=your_id
POSTHOG_PROJECT_KEY=phc_your_project_key
```

## 📖 Usage

### Dry Run
This will log every identification and merge to the console without sending any data to PostHog.
```bash
node src/index.js --dry-run
```

### Live Run
This will process your person database and send identification updates to PostHog in batches of 1,000.
```bash
node src/index.js
```

## 🔍 Under the Hood

### Person Merging Logic
When a "Good Bot" is identified (e.g., by User Agent or verified IP), the script:
1. Changes the `distinct_id` to the bot's name (e.g., `Googlebot`).
2. Sends a `$identify` event to PostHog.
3. Includes the `$anon_distinct_id` (the original UUID).
4. **Result**: PostHog merges all previous history from that UUID into the central bot record.

A "Bad Bot" usually hides behind normal User Agents and is only detected by IP blacklists.
Bad Bots are merged by IP address only.

### Performance Design
The script avoids the PostHog API's `OFFSET` bottleneck by using lexicographical sorting on `person.id`. This ensures consistency and prevents the script from slowing down as it reaches the later records in your database.

## 📜 License
ISC License
