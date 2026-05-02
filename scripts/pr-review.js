#!/usr/bin/env node

import { Octokit } from "@octokit/rest";
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * AI Assistant Script for Lampa Project - Extreme Simplicity Version
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PR_NUMBER = parseInt(process.env.PR_NUMBER);
const REPO_FULL_NAME = process.env.REPO_FULL_NAME;
const COMMENT_BODY = process.env.COMMENT_BODY || '';
const COMMENT_ID = process.env.COMMENT_ID;
const MODEL_NAME = "gemma-4-31b-it";

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
        return `Analyze this diff and return results. Mode: ${mode}`;
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

function parseSimpleMarkers(text, mode) {
    const result = { general_answer: "", comments: [] };

    // Extract Summary
    const summaryMatch = text.match(/SUMMARY:\s*(.+)/i);
    if (summaryMatch) result.general_answer = summaryMatch[1].trim();

    if (mode === 'test') {
        const fileRegex = /FILE:\s*(.+?)\s*CODE:\s*([\s\S]*?)END_FILE/gi;
        let match;
        while ((match = fileRegex.exec(text)) !== null) {
            result.comments.push({
                file: match[1].trim(),
                suggestion: match[2].trim(),
                comment: "AI Generated Test"
            });
        }
    } else {
        const commentRegex = /COMMENT_START([\s\S]*?)COMMENT_END/gi;
        let match;
        while ((match = commentRegex.exec(text)) !== null) {
            const block = match[1];
            const file = block.match(/FILE:\s*(.+)/i)?.[1]?.trim();
            const line = block.match(/LINE:\s*(\d+)/i)?.[1]?.trim();
            const msg = block.match(/TEXT:\s*(.+)/i)?.[1]?.trim();
            const suggestion = block.match(/SUGGESTION:\s*([\s\S]*?)END_SUGGESTION/i)?.[1]?.trim();

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

    const userText = `${prompt}\n\nDIFF DATA:\n${diffData}\n\nCONTEXT:\n${priorityFilesContext}\n\nCOMMAND: Generate results now. NO CHAT. START WITH FILE:`;

    const payload = {
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.0 }
    };

    console.log("=== AI REQUEST (EXTREME SIMPLICITY) ===");
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`API error: ${response.status} - ${err}`);
    }

    const resJson = await response.json();
    if (!resJson.candidates || !resJson.candidates[0].content) return { general_answer: "No response", comments: [] };
    
    let text = resJson.candidates[0].content.parts[0].text;
    
    // Nudge the text if it doesn't start with FILE:
    if (!text.trim().startsWith('FILE:') && !text.trim().startsWith('COMMENT_START')) {
        text = 'FILE: ' + text;
    }

    console.log("=== AI FULL RESPONSE ===");
    console.log(text);
    
    const parsed = parseSimpleMarkers(text, mode);
    
    if (parsed.comments.length === 0 && !parsed.general_answer) {
        throw new Error("Failed to extract markers. Model did not follow the FILE/CODE format.");
    }

    return parsed;
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
                const body = result.general_answer || "✅ **Code Review completed.**\nNo issues found.";
                await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body });
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
