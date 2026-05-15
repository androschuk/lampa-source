#!/usr/bin/env node

import { Octokit } from "@octokit/rest";
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * AI Assistant Script for Lampa Project - XML Parsing Version
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PR_NUMBER = parseInt(process.env.PR_NUMBER);
const REPO_FULL_NAME = process.env.REPO_FULL_NAME;
const COMMENT_BODY = process.env.COMMENT_BODY || '';
const COMMENT_ID = process.env.COMMENT_ID;
const MODEL_NAME = "gemini-3.1-flash-lite";

if (!GITHUB_TOKEN || !GEMINI_API_KEY || !PR_NUMBER || !REPO_FULL_NAME || !COMMENT_ID) {
    console.error("Error: Missing required environment variables.");
    process.exit(1);
}

const [owner, repo] = REPO_FULL_NAME.split("/");
const octokit = new Octokit({ auth: GITHUB_TOKEN });

const IGNORED_PATHS = ['src/lang/', '.github/', 'package-lock.json', 'dist/', 'build/'];
const MAX_CONTEXT_CHARS = 800000; // ~200k-250k tokens safety cap

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        const response = await fetch(url, options);
        if (response.ok) return response;
        
        // Don't retry on 400/401/403/404 unless it's a rate limit (429)
        const isTransient = response.status === 429 || response.status >= 500;
        if (!isTransient || i === retries - 1) {
            const err = await response.text();
            throw new Error(`API error: ${response.status} - ${err}`);
        }

        const wait = Math.pow(2, i) * 2000;
        console.log(`[AI] Request failed (${response.status}). Retrying in ${wait}ms... (${i + 1}/${retries})`);
        await sleep(wait);
    }
}

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
        const content = fs.readFileSync(skillPath, 'utf-8').replace(/\r\n/g, '\n');
        const findSection = (tag) => {
            const regex = new RegExp(`# ${tag}\\s*\\n([\\s\\S]*?)(?=\\n#|$)`, 'i');
            const match = content.match(regex);
            return match ? match[1].trim() : '';
        };

        let sys = findSection('SYSTEM_PROMPT');
        const modeInst = findSection(`MODE_INSTRUCTIONS_${mode.toUpperCase()}`) || findSection('MODE_INSTRUCTIONS_DEFAULT');
        
        return sys
            .replace('{{modeInstructions}}', modeInst)
            .replace('{{userQuery}}', userQuery);
    } catch (e) {
        return `Analyze this diff and return results in XML <REPORT> block. Mode: ${mode}`;
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

function parseXmlResponse(text, mode) {
    const result = { general_answer: "", comments: [] };

    // Extract Summary
    const summaryMatch = text.match(/<SUMMARY>([\s\S]*?)<\/SUMMARY>/i);
    if (summaryMatch) result.general_answer = summaryMatch[1].trim();

    if (mode === 'test') {
        const fileRegex = /<FILE path="(.+?)">[\s\S]*?<CODE>([\s\S]*?)<\/CODE>[\s\S]*?<\/FILE>/gi;
        let match;
        while ((match = fileRegex.exec(text)) !== null) {
            result.comments.push({
                file: match[1].trim(),
                suggestion: match[2].trim(),
                comment: "AI Generated Test"
            });
        }
    } else {
        const commentRegex = /<COMMENT>([\s\S]*?)<\/COMMENT>/gi;
        let match;
        while ((match = commentRegex.exec(text)) !== null) {
            const block = match[1];
            const file = block.match(/<FILE>([\s\S]*?)<\/FILE>/i)?.[1]?.trim();
            const line = block.match(/<LINE>([\s\S]*?)<\/LINE>/i)?.[1]?.trim();
            const msg = block.match(/<TEXT>([\s\S]*?)<\/TEXT>/i)?.[1]?.trim();
            const suggestion = block.match(/<SUGGESTION>([\s\S]*?)<\/SUGGESTION>/i)?.[1]?.trim();

            if (file && line) {
                result.comments.push({
                    file,
                    line: parseInt(line),
                    comment: msg || "🔍 Suggestion",
                    suggestion: (suggestion === 'null' || !suggestion) ? null : suggestion
                });
            }
        }
    }

    return result;
}

async function analyzeWithGemini(diffData, priorityFilesContext, mode, userQuery = '') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;
    const prompt = loadPrompts(mode, userQuery);

    const userText = `${prompt}\n\nFILE CONTEXT:\n${priorityFilesContext}\n\nDIFF DATA:\n${diffData}\n\nFINAL TASK: Start with <THOUGHTS>, then provide the <REPORT>.`;

    console.log(`[AI] Requesting ${MODEL_NAME}. Payload size: ${userText.length} chars.`);

    const payload = {
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: { 
            temperature: 0.2,
            maxOutputTokens: 4096
        }
    };

    console.log("=== AI REQUEST (XML MODE) ===");
    const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify(payload)
    });

    const resJson = await response.json();
    if (!resJson.candidates || !resJson.candidates[0].content) return { general_answer: "No response", comments: [] };
    
    let text = resJson.candidates[0].content.parts[0].text;
    console.log("=== AI FULL RESPONSE ===");
    console.log(text);
    
    const parsed = parseXmlResponse(text, mode);
    
    if (parsed.comments.length === 0 && !parsed.general_answer) {
        throw new Error("Failed to extract results from XML tags.");
    }

    return parsed;
}

async function main() {
    const mode = COMMENT_BODY.includes('/ai add test') ? 'test' : (COMMENT_BODY.includes('/ai review') ? 'default' : 'query');
    await manageReaction('add');

    try {
        const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: PR_NUMBER });
        const filteredFiles = files.filter(f => !IGNORED_PATHS.some(p => f.filename.startsWith(p)) && f.status !== 'removed' && f.patch);

        // Concurrent file reading
        const processedFiles = await Promise.all(filteredFiles.map(async (file) => {
            let content = null;
            try {
                const filePath = path.join(process.cwd(), file.filename);
                if (fs.existsSync(filePath)) {
                    content = fs.readFileSync(filePath, 'utf-8');
                }
            } catch (e) { }
            return { ...file, fullContent: content };
        }));

        let diffData = "";
        let fullContext = "";

        for (const file of processedFiles) {
            diffData += `--- DIFF: ${file.filename} ---\n${file.patch}\n\n`;
            
            if (file.fullContent) {
                const chunk = `--- FULL FILE: ${file.filename} ---\n${file.fullContent}\n\n`;
                if ((fullContext.length + chunk.length) < MAX_CONTEXT_CHARS) {
                    fullContext += chunk;
                } else {
                    console.warn(`[Warning] Context cap reached. Skipping full content for: ${file.filename}`);
                }
            }
        }

        const result = await analyzeWithGemini(diffData, fullContext, mode);
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
                const body = result.general_answer || "✅ **Code Review completed.**\nNo issues found.";
                await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body });
            }
        }
    } catch (err) {
        console.error(err);
        await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body: "❌ **AI Assistant Error**: Something went wrong while processing your request. Please check the action logs for details." });
    } finally {
        await manageReaction('complete');
    }
}

main();
