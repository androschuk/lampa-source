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
        return `As a senior engineer, provide a code review for mode: ${mode}.`;
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

    const mergedPrompt = `${prompt}\n\nTask: Return only a JSON object. No explanation, no planning, no bullet points. 
JSON Schema: {"general_answer": "summary", "comments": [{"file": "path", "line": number, "comment": "text", "suggestion": "code"}]}

Diff Data:
${diffData}

Return ONLY the JSON object now.`;

    const payload = {
        contents: [{ role: "user", parts: [{ text: mergedPrompt }] }],
        generationConfig: { temperature: 0.1 }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const result = await response.json();
    if (!result.candidates) return { general_answer: "No response", comments: [] };
    
    const text = result.candidates[0].content.parts[0].text.trim();
    
    const extractJSON = (str) => {
        // 1. Try to find JSON in markdown blocks
        const codeBlockMatch = str.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (codeBlockMatch) {
            try { return JSON.parse(codeBlockMatch[1]); } catch (e) {}
        }

        // 2. Try to find the first '{' and last '}'
        const first = str.indexOf('{');
        const last = str.lastIndexOf('}');
        if (first !== -1 && last !== -1 && last > first) {
            const candidate = str.substring(first, last + 1);
            try { return JSON.parse(candidate); } catch (e) {}
        }
        return null;
    };

    const parsed = extractJSON(text);
    if (parsed) return parsed;

    console.log("[DEBUG] Raw AI Output (Failed to parse):", text);
    return { general_answer: "Parsing failed", comments: [] };
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
                await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body: "❌ **AI Assistant**: No tests were generated. The model provided an invalid response format." });
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
    } finally {
        await manageReaction('complete');
    }
}

main();
