require('dotenv').config();
const axios = require('axios');
const { isbot, isbotMatch } = require('isbot');
const { loadAllBotData } = require('./bot-data');

// Configuration
const API_KEY = process.env.POSTHOG_API_KEY;
const PROJECT_ID = process.env.POSTHOG_API_ID || process.env.POSTHOG_PROJECT_ID; // Support both
const PROJECT_KEY = process.env.POSTHOG_PROJECT_KEY;
const BASE_URL = 'https://app.posthog.com';
const BATCH_URL = 'https://us.i.posthog.com/batch/';
const isDryRun = process.argv.includes('--dry-run');
const isVerbosePerformance = process.argv.includes('--perf');

const BATCH_SIZE = 1000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

if (!API_KEY || !PROJECT_ID || !PROJECT_KEY) {
    console.error("Error: POSTHOG_API_KEY, POSTHOG_PROJECT_ID, and POSTHOG_PROJECT_KEY must be set in .env");
    process.exit(1);
}

// Statistics
const stats = {
    processed: 0,
    modified: 0,
    goodBotsAlready: 0,
    goodBotsNew: 0,
    badBotsAlready: 0,
    badBotsNew: 0,
    botsWithNames: 0,
    totalBotsFound: 0,
    botsWithCategories: 0,
    initialIpsAlready: 0,
    initialIpsNew: 0,
    latestIpsAlready: 0,
    latestIpsNew: 0,
    datacentersAlready: 0,
    datacentersNew: 0,
    latestNonProxyIpsAlready: 0,
    latestNonProxyIpsNew: 0,
    errors: 0,
    retries: 0
};

// Performance Metrics
const perf = {
    totalHogQLTime: 0,
    totalSearchTime: 0,
    totalIdentifyTime: 0,
    totalWriteTime: 0,
    batchCount: 0
};

let botData;

async function start() {
    console.log("Loading bot data sources from live URLs...");
    botData = await loadAllBotData();
    console.log("Data loaded. Starting processing...");

    try {
        await processPersons();
    } catch (err) {
        console.error("Critical error during processing:", err);
    }
}

async function fetchWithRetry(fn, context = '') {
    let retries = 0;
    const MAX_RETRIES = 10;
    let backoff = 2000;

    while (retries < MAX_RETRIES) {
        try {
            return await fn();
        } catch (error) {
            if (error.response && error.response.status === 429) {
                retries++;
                stats.retries++;
                const retryAfter = error.response.headers['retry-after']
                    ? parseInt(error.response.headers['retry-after']) * 1000
                    : 0;
                const waitTime = retryAfter > 0 ? retryAfter : backoff;
                console.warn(`\n[429] Rate Limited (${context}). Waiting ${waitTime / 1000}s...`);
                await sleep(waitTime);
                backoff = Math.min(backoff * 1.5, 60000);
                continue;
            }
            if (error.response && error.response.status >= 500) {
                retries++;
                stats.retries++;
                await sleep(backoff);
                backoff = Math.min(backoff * 1.5, 60000);
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Max retries exceeded for ${context}`);
}

async function fetchHogQL(querySql) {
    const url = `${BASE_URL}/api/projects/${PROJECT_ID}/query/`;
    const query = {
        kind: "HogQLQuery",
        query: querySql
    };

    const start = Date.now();
    try {
        const response = await fetchWithRetry(() => axios.post(url, { query }, {
            headers: { Authorization: `Bearer ${API_KEY}` }
        }), 'HogQL Fetch');
        perf.totalHogQLTime += (Date.now() - start);
        return response.data;
    } catch (error) {
        console.error(`Error executing HogQL: ${error.message}`);
        return null;
    }
}

function checkBot(ip, userAgent) {
    const start = Date.now();
    const result = {
        isBot: false,
        isGoodBot: undefined,
        botName: undefined,
        botType: undefined,
        botSource: undefined,
        isDatacenter: false,
        datacenterName: undefined
    };

    if (ip) {
        // Find all possible matches (Specific IP and Range matches)
        const singleMatch = botData.singleIPs.get(ip);
        const rangeMatch = botData.findInRange(ip);

        // Merge them if both exist, prioritizing the most specific match
        let match = singleMatch;
        if (rangeMatch) {
            if (!match) {
                match = rangeMatch;
            } else {
                // If we have both, we need to merge them.
                // We'll use a temporary merge similar to what's in bot-data.js 
                // but since we want to be safe, let's just combine the objects.
                match = {
                    ...rangeMatch,
                    ...singleMatch,
                    // Ensure we don't lose the DC name if it was in the range but not the single IP
                    datacenter: singleMatch.datacenter || rangeMatch.datacenter || (rangeMatch.type === 'datacenter' ? rangeMatch.name : null),
                    name: (singleMatch.name && singleMatch.name !== 'Unknown') ? singleMatch.name : (rangeMatch.name !== 'Unknown' ? rangeMatch.name : 'Unknown'),
                    source: `${singleMatch.source} + ${rangeMatch.source}`
                };
            }
        }

        if (match) {
            // Apply bot properties if it's a bot
            if (match.type === 'bot') {
                result.isBot = true;
                result.botName = (match.name && match.name !== 'Unknown') ? match.name : null;
                result.botType = (match.category && match.category !== 'Uncategorized') ? match.category : 'Unknown';
                result.botSource = match.source || 'IP List';
                if (match.rating === 'good') result.isGoodBot = true;
                if (match.rating === 'bad') result.isGoodBot = false;
            }

            // Apply datacenter properties if it's a datacenter OR if a bot has merged DC info
            if (match.type === 'datacenter' || match.datacenter) {
                result.isDatacenter = true;
                result.datacenterName = match.datacenter || match.name;

                // If it wasn't already marked as a bot (e.g. pure Datacenter match), but we still want stats
                if (!result.isBot && match.type === 'datacenter') {
                    // It's a datacenter, but not necessarily a "bot" in the crawler sense
                }
            }

            // Clean up generic/unwanted names
            const untaggedNames = ['Firehol Blocklist', 'Avastel Blocklist', 'Unknown', 'Uncategorized'];
            if (untaggedNames.includes(result.botName)) result.botName = null;
            if (untaggedNames.includes(result.datacenterName)) result.datacenterName = null;
        }
    }

    if (!result.isBot && userAgent && isbot(userAgent)) {
        result.isBot = true;
        let match = isbotMatch(userAgent);
        if (match && match.replace(/[^a-zA-Z0-9]/g, '').length >= 2) {
            match = match.trim();
            if (userAgent.includes('LinkCheck by Siteimprove.com')) match = 'LinkCheck by Siteimprove.com';
            if (userAgent.includes('Sogou web spider')) match = 'Sogou web spider';
            if (userAgent.includes('Archive-It')) match = 'Archive-It';
            if (match.startsWith('PTST')) match = 'PTST';
            if (match === 'Url' && userAgent.includes('LarkUrl')) match = 'LarkUrl';
            result.botName = (match === 'GoodBot') ? null : match;
        }
        result.botType = "Crawler";
        result.botSource = "isbot (User Agent)";
        result.isGoodBot = true;
    }

    perf.totalIdentifyTime += (Date.now() - start);
    return result;
}

async function sendBatch(events) {
    if (events.length === 0) return;
    const start = Date.now();
    if (isDryRun) {
        perf.totalWriteTime += (Date.now() - start);
        return;
    }
    try {
        await fetchWithRetry(() => axios.post(BATCH_URL, {
            api_key: PROJECT_KEY,
            batch: events
        }, { headers: { 'Content-Type': 'application/json' } }), 'Send Batch');
        stats.updated += events.length;
    } catch (error) {
        console.error(`[BATCH] Error: \${error.message}`);
        stats.errors += events.length;
    }
    perf.totalWriteTime += (Date.now() - start);
}

async function processPersons() {
    process.stdout.write('\x1Bc'); // Clear screen
    console.log(`Starting Bot Analysis... mode=\${isDryRun ? 'DRY-RUN' : 'LIVE'} perf=\${isVerbosePerformance ? 'VERBOSE' : 'BASIC'}`);

    const LIMIT = 5000;
    let lastPersonId = '';
    let eventBatch = [];

    while (true) {
        perf.batchCount++;
        // OPTIMIZATION: If Initial IP is missing, we fetch ANY IP ($ip). 
        // We only ever need to find the "latest context" once per person.
        const querySql = `
            SELECT 
                person.id,
                any(distinct_id), 
                any(person.properties.is_bot), 
                argMax(properties['$ip'], timestamp), 
                argMax(properties['$raw_user_agent'], timestamp),
                any(person.properties['$initial_ip']),
                any(person.properties['$latest_ip']),
                any(person.properties.is_good_bot),
                any(person.properties.datacenter),
                any(person.properties['$latest_nonproxy_ip'])
            FROM events
            ${lastPersonId ? `WHERE person.id > '${lastPersonId}'` : ''}
            GROUP BY person.id 
            ORDER BY person.id
            LIMIT ${LIMIT}
        `;

        const data = await fetchHogQL(querySql);
        if (!data || !data.results || data.results.length === 0) break;

        const loopStart = Date.now();
        for (const row of data.results) {
            stats.processed++;
            const [personId, distinctId, isBotProp, processedIp, userAgent, existingInitialIp, existingLatestIp, existingIsGoodBot, existingDatacenter, existingLatestNonProxyIp] = row;
            lastPersonId = personId;

            let analysis = checkBot(processedIp, userAgent);
            if (!analysis.isBot && existingInitialIp && existingInitialIp !== processedIp) {
                const initialAnalysis = checkBot(existingInitialIp, userAgent);
                if (initialAnalysis.isBot) analysis = initialAnalysis;
                if (initialAnalysis.isDatacenter && !analysis.isDatacenter) {
                    analysis.isDatacenter = true;
                    analysis.datacenterName = initialAnalysis.datacenterName;
                }
            }

            // ROBUST TYPE CHECKS (PostHog might return 1/0, true/false, or strings)
            const isBotAlready = (isBotProp === true || isBotProp === 1 || isBotProp === 'true' || isBotProp === '1');
            const isGoodAlready = (existingIsGoodBot === true || existingIsGoodBot === 1 || existingIsGoodBot === 'true' || existingIsGoodBot === '1');
            const isBadAlready = isBotAlready && (existingIsGoodBot === false || existingIsGoodBot === 0 || existingIsGoodBot === 'false' || existingIsGoodBot === '0');
            const hasDatacenterAlready = existingDatacenter && existingDatacenter !== 'null';

            // TRACK BOT STATS
            if (analysis.isBot) {
                stats.totalBotsFound++;
                if (analysis.botName) stats.botsWithNames++;
                if (analysis.botType) stats.botsWithCategories++;

                if (analysis.isGoodBot) {
                    if (isGoodAlready) stats.goodBotsAlready++;
                    else stats.goodBotsNew++;
                } else {
                    if (isBadAlready) stats.badBotsAlready++;
                    else stats.badBotsNew++;
                }
            }

            // TRACK DATACENTER STATS
            if (analysis.isDatacenter) {
                // Check if the property exists at all or matches closely enough
                if (hasDatacenterAlready) stats.datacentersAlready++;
                else stats.datacentersNew++;
            }

            const props = {
                is_bot: analysis.isBot,
                is_good_bot: analysis.isBot ? (analysis.isGoodBot || false) : null,
                bot_name: analysis.botName || null,
                bot_type: analysis.botType || null,
                bot_identification_source: analysis.botSource || null,
                datacenter: analysis.datacenterName || null
            };

            // TRACK IP STATS
            if (existingInitialIp) stats.initialIpsAlready++;
            if (existingLatestIp && existingLatestIp === processedIp) stats.latestIpsAlready++;

            if (processedIp && processedIp !== existingLatestIp) {
                if (!existingInitialIp) {
                    props.$initial_ip = processedIp;
                    stats.initialIpsNew++;
                }
                props.$latest_ip = processedIp;
                stats.latestIpsNew++;
            }

            // TRACK LATEST NON-PROXY IP (Only for non-bots, non-datacenters)
            if (!analysis.isBot && !analysis.isDatacenter && processedIp) {
                if (existingLatestNonProxyIp && existingLatestNonProxyIp === processedIp) {
                    stats.latestNonProxyIpsAlready++;
                } else {
                    props.$latest_nonproxy_ip = processedIp;
                    stats.latestNonProxyIpsNew++;
                }
            }

            const filteredProps = Object.fromEntries(Object.entries(props).filter(([k, v]) => {
                // Only set if different from existing or new
                if (k === 'is_bot' && (v === isBotAlready)) return false;
                if (k === 'is_good_bot' && (v === isGoodAlready)) return false;
                if (k === 'datacenter' && v === existingDatacenter) return false;
                if (k === '$latest_ip' && v === existingLatestIp) return false;
                if (k === '$initial_ip' && v === existingInitialIp) return false;
                if (k === '$latest_nonproxy_ip' && v === existingLatestNonProxyIp) return false;
                return v != null;
            }));
            let effectiveDistinctId = distinctId;
            let eventName = '$set';

            if (analysis.isBot) {
                if (analysis.isGoodBot && analysis.botName) {
                    effectiveDistinctId = analysis.botName;
                } else if (analysis.isGoodBot === false) {
                    effectiveDistinctId = `${analysis.botName || 'Unknown Bad Bot'} (${processedIp || 'No IP'})`;
                }

                if (effectiveDistinctId !== distinctId) {
                    eventName = '$identify';
                }
            }

            const hasUpdates = Object.keys(filteredProps).length > 0;
            const isIdentify = eventName === '$identify';

            if (analysis.isBot || analysis.isDatacenter) {
                process.stdout.write('\r\x1b[K');
                console.log(`\n[Identify] ${effectiveDistinctId}${effectiveDistinctId !== distinctId ? ` (Original: ${distinctId})` : ''} - IP: ${processedIp}`);
                console.log(`UA: "${userAgent}"`);
                console.log(JSON.stringify(filteredProps, null, 2));
            }

            if (hasUpdates || isIdentify) {
                stats.modified++;
                const event = { event: eventName, properties: { $set: filteredProps, $set_once: {} }, distinct_id: effectiveDistinctId };
                if (isIdentify) event.properties.$anon_distinct_id = distinctId;
                eventBatch.push(event);
            }

            if (eventBatch.length >= BATCH_SIZE) {
                await sendBatch(eventBatch);
                eventBatch = [];
            }

            if (stats.processed % 100 === 0) {
                const avgHogQL = (perf.totalHogQLTime / stats.processed).toFixed(1);
                const avgIdent = (perf.totalIdentifyTime / stats.processed).toFixed(1);
                process.stdout.write(`\rProcessed: ${stats.processed} | Bots: ${stats.totalBotsFound} | Latency: ${avgHogQL}ms(DB) ${avgIdent}ms(CPU)`);
            }
        }
        perf.totalSearchTime += (Date.now() - loopStart);
    }

    if (eventBatch.length > 0) await sendBatch(eventBatch);

    process.stdout.write('\r\x1b[K');
    console.log('\n--- Final Stats ---');
    console.log(`${stats.processed} Posthog Persons found, ${stats.modified} modified.`);
    console.log('');
    console.log(`Good Bots: ${stats.goodBotsAlready} already tagged, ${stats.goodBotsNew} newly tagged`);
    console.log(`Bad Bots: ${stats.badBotsAlready} already tagged, ${stats.badBotsNew} newly tagged`);
    console.log('');
    console.log(`Bots with names: ${stats.botsWithNames} / ${stats.totalBotsFound}`);
    console.log(`Bots with categories: ${stats.botsWithCategories} / ${stats.totalBotsFound}`);
    console.log('');
    console.log(`Person Initial IPs: ${stats.initialIpsAlready} already tagged, ${stats.initialIpsNew} newly tagged`);
    console.log(`Person Latest IPs: ${stats.latestIpsAlready} already latest, ${stats.latestIpsNew} updated`);
    console.log(`Person Non-Proxy IPs: ${stats.latestNonProxyIpsAlready} already current, ${stats.latestNonProxyIpsNew} updated`);
    console.log(`Datacenter IPs: ${stats.datacentersAlready} already tagged, ${stats.datacentersNew} newly tagged`);
    console.log('');
    console.log(`Database Wait: ${(perf.totalHogQLTime / 1000).toFixed(1)}s`);
    console.log(`Processing Time: ${(perf.totalSearchTime / 1000).toFixed(1)}s`);
    console.log(`Write Time: ${(perf.totalWriteTime / 1000).toFixed(1)}s`);
}

// Start processing
start();
