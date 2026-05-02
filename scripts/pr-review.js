#!/usr/bin/env node

import { Octokit } from "@octokit/rest";
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * AI Assistant Script for Lampa Project
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PR_NUMBER = parseInt(process.env.PR_NUMBER);
const REPO_FULL_NAME = process.env.REPO_FULL_NAME;
const COMMENT_BODY = process.env.COMMENT_BODY || '';
const COMMENT_ID = process.env.COMMENT_ID;
const MODEL_NAME = "gemma-4-31b-it";
const IS_REVIEW_COMMENT = process.env.IS_REVIEW_COMMENT === 'true';

if (!GITHUB_TOKEN || !GEMINI_API_KEY || !PR_NUMBER || !REPO_FULL_NAME || !COMMENT_ID) {
    console.error("Error: Missing required environment variables.");
    process.exit(1);
}

const [owner, repo] = REPO_FULL_NAME.split("/");
const octokit = new Octokit({ auth: GITHUB_TOKEN });

const IGNORED_PATHS = ['src/lang/', '.github/', 'package-lock.json', 'dist/', 'build/'];

function runCommand(command) {
    try {
        console.log(`[Shell] Executing: ${command}`);
        return execSync(command, { encoding: 'utf8', stdio: 'inherit' });
    } catch (e) {
        console.error(`[Shell Error] Command failed: ${e.message}`);
        throw e;
    }
}

function loadPrompts(mode, userQuery = '') {
    const skillName = mode === 'test' ? 'test-generation-prompts' : 'code-review-prompts';
    const skillPath = path.join(process.cwd(), `.gemini/skills/${skillName}/SKILL.md`);
    
    try {
        const content = fs.readFileSync(skillPath, 'utf-8');
        const extractSection = (tag) => {
            const regex = new RegExp(`# ${tag}\\r?\\n([\\s\\S]*?)(?=\\r?\\n#|$)`);
            const match = content.match(regex);
            return match ? match[1].trim() : '';
        };

        const systemPromptTemplate = extractSection('SYSTEM_PROMPT');
        const inst = extractSection(mode === 'test' ? 'INSTRUCTIONS' : 'MODE_INSTRUCTIONS_DEFAULT');
        
        return systemPromptTemplate
            .replace('{{mode}}', mode)
            .replace('{{modeInstructions}}', inst)
            .replace('{{userQuery}}', userQuery);
    } catch (e) {
        return `JSON-only review. Mode: ${mode}`;
    }
}

async function manageReaction(action) {
    try {
        if (action === 'add') {
            await octokit.reactions.createForIssueComment({ owner, repo, comment_id: COMMENT_ID, content: 'eyes' });
        } else if (action === 'remove') {
            const { data: reactions } = await octokit.reactions.listForIssueComment({ owner, repo, comment_id: COMMENT_ID });
            const eye = reactions.find(r => r.content === 'eyes' && r.user.login.includes('github-actions'));
            if (eye) await octokit.reactions.deleteForIssueComment({ owner, repo, comment_id: COMMENT_ID, reaction_id: eye.id });
        } else if (action === 'complete') {
            await manageReaction('remove');
            await octokit.reactions.createForIssueComment({ owner, repo, comment_id: COMMENT_ID, content: '+1' });
        }
    } catch (e) { }
}

async function analyzeWithGemini(diffData, priorityFilesContext, mode, userQuery = '') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;
    const prompt = loadPrompts(mode, userQuery);

    const payload = {
        system_instruction: {
            parts: [{ text: "You are a specialized tool that returns ONLY JSON objects wrapped in markdown code blocks. Never include any other text." }]
        },
        contents: [{ 
            role: "user", 
            parts: [{ text: `${prompt}\n\nDIFF DATA:\n${diffData}\n\nCONTEXT:\n${priorityFilesContext}\n\nCOMMAND: Analyze the data and return the JSON object wrapped in a markdown code block.\n\nJSON:\n\`\`\`json` }] 
        }],
        generationConfig: { 
            temperature: 0.1,
            response_mime_type: "application/json"
        }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`API error: ${response.status} - ${err}`);
    }

    const result = await response.json();
    if (!result.candidates) return { general_answer: "No response", comments: [] };
    
    let text = result.candidates[0].content.parts[0].text.trim();
    
    // Strategy 1: Look for markdown code blocks
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
        const candidate = codeBlockMatch[1].trim();
        try {
            return JSON.parse(candidate);
        } catch (e) {
            console.warn(`[AI] Failed to parse JSON from code block: ${e.message}`);
        }
    }

    // Strategy 2: Standard JSON parse
    try {
        return JSON.parse(text);
    } catch (e) { }

    console.warn(`[AI] Standard parsing failed, trying brute-force extraction...`);
    
    // Strategy 3: Brute-force extraction of the longest { } pair
    let bestJson = null;
    let firstBrace = -1;
    while ((firstBrace = text.indexOf('{', firstBrace + 1)) !== -1) {
        let lastBrace = text.length;
        while ((lastBrace = text.lastIndexOf('}', lastBrace - 1)) !== -1 && lastBrace > firstBrace) {
            const candidate = text.substring(firstBrace, lastBrace + 1);
            try {
                const parsed = JSON.parse(candidate);
                if (!bestJson || candidate.length > JSON.stringify(bestJson).length) {
                    bestJson = parsed;
                }
            } catch (e) {
                // Try fix common issues (single quotes)
                if (candidate.includes("'")) {
                    try {
                        const fixed = candidate.replace(/([{,]\s*)'([^']+)':/g, '$1"$2":');
                        const parsed = JSON.parse(fixed);
                        if (!bestJson || fixed.length > JSON.stringify(bestJson).length) {
                            bestJson = parsed;
                        }
                    } catch (e2) { }
                }
            }
        }
    }

    if (bestJson) return bestJson;

    console.error(`[AI] Failed to extract any valid JSON object.`);
    console.error(`[AI] Raw output snippet (500 chars):\n${text.substring(0, 500)}`);
    throw new Error("Invalid JSON returned by AI. See logs for details.");
}

async function main() {
    const mode = COMMENT_BODY.includes('/ai add test') ? 'test' : (COMMENT_BODY.includes('/ai review') ? 'default' : 'query');
    await manageReaction('add');

    try {
        const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: PR_NUMBER });
        const filteredFiles = files.filter(f => !IGNORED_PATHS.some(p => f.filename.startsWith(p)) && f.status !== 'removed' && f.patch);

        let diffData = "";
        for (const file of filteredFiles) {
            diffData += `--- ${file.filename} ---\n${file.patch}\n\n`;
        }

        const result = await analyzeWithGemini(diffData, "", mode);
        const reviewItems = result.comments || [];

        if (mode === 'test') {
            const created = [];
            for (const item of reviewItems) {
                if (item.file && item.suggestion) {
                    const dir = path.dirname(item.file);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(item.file, item.suggestion);
                    created.push(item.file);
                }
            }
            if (created.length > 0) {
                runCommand(`git add ${created.join(' ')}`);
                runCommand(`git commit -m "test: add unit tests generated by AI"`);
                runCommand(`git push origin HEAD`);
                const body = `✅ **AI Assistant**: Added tests: ${created.map(f => `\`${f}\``).join(', ')}`;
                await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body });
            } else {
                await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body: "❌ **AI Assistant**: No tests were generated." });
            }
        } else {
            const prFiles = new Set(filteredFiles.map(f => f.filename));
            const comments = reviewItems.map(item => {
                if (!prFiles.has(item.file)) return null;
                const body = `${item.comment}${item.suggestion ? `\n\n\`\`\`suggestion\n${item.suggestion}\n\`\`\`` : ''}`;
                return { path: item.file, line: parseInt(item.line), side: 'RIGHT', body };
            }).filter(c => c && !isNaN(c.line) && c.line > 0);

            if (comments.length > 0) {
                await octokit.pulls.createReview({ owner, repo, pull_number: PR_NUMBER, event: 'COMMENT', comments });
            } else {
                await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body: "✅ **Code Review completed.**\nNo issues found." });
            }
        }
    } catch (err) {
        console.error(err);
        await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body: `❌ **AI Assistant Error**: ${err.message}` });
    } finally {
        await manageReaction('complete');
    }
}

main();
