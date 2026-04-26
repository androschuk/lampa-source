#!/usr/bin/env node

import { Octokit } from "@octokit/rest";
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * AI Assistant Script for Lampa Project
 * Handles Code Review, Queries, and Automatic Test Generation.
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

/**
 * Loads prompts from a specific skill folder.
 */
function loadPrompts(mode, userQuery = '') {
    const skillName = mode === 'test' ? 'test-generation-prompts' : 'code-review-prompts';
    const skillPath = path.join(process.cwd(), `.gemini/skills/${skillName}/SKILL.md`);
    
    console.log(`[Config] Loading prompts from: ${skillPath}`);
    try {
        const content = fs.readFileSync(skillPath, 'utf-8');
        
        const extractSection = (tag) => {
            const regex = new RegExp(`# ${tag}\\r?\\n([\\s\\S]*?)(?=\\r?\\n#|$)`);
            const match = content.match(regex);
            return match ? match[1].trim() : '';
        };

        const systemPromptTemplate = extractSection('SYSTEM_PROMPT');
        const secureInst = extractSection('MODE_INSTRUCTIONS_SECURE');
        const perfInst = extractSection('MODE_INSTRUCTIONS_PERF');
        const defaultInst = extractSection('MODE_INSTRUCTIONS_DEFAULT');
        const queryInst = extractSection('MODE_INSTRUCTIONS_QUERY');
        const instructions = extractSection('INSTRUCTIONS'); // For test mode

        const modeInstructions = {
            secure: secureInst,
            perf: perfInst,
            query: queryInst,
            test: instructions,
            default: defaultInst
        };

        const inst = modeInstructions[mode] || modeInstructions.default;
        
        return systemPromptTemplate
            .replace('{{mode}}', mode)
            .replace('{{modeInstructions}}', inst)
            .replace('{{userQuery}}', userQuery);
    } catch (e) {
        console.error(`[Error] Failed to load prompts from ${skillPath}: ${e.message}`);
        return `Perform a code review for mode: ${mode}. Return JSON structure.`;
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
        }
    } catch (e) {
        console.warn(`Warning: Reaction ${action} failed: ${e.message}`);
    }
}

function getReviewMode() {
    if (COMMENT_BODY.includes('/ai add test')) return 'test';
    const reviewMatch = COMMENT_BODY.match(/\/ai review\s+(\w+)/);
    if (reviewMatch) return reviewMatch[1];
    if (COMMENT_BODY.match(/\/ai\s+(?!build|review|add test)[\s\S]+/)) return 'query';
    return 'default';
}

function getUserQuery() {
    const match = COMMENT_BODY.match(/\/ai\s+([\s\S]+)/);
    if (!match) return '';
    let query = match[1].trim();
    query = query.replace(/^(query|add test|review\s+\w+)\s*/i, '');
    return query;
}

async function fetchPRFiles() {
    const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: PR_NUMBER });
    return files.filter(file => {
        const isIgnored = IGNORED_PATHS.some(ignored => file.filename.startsWith(ignored));
        return !isIgnored && file.status !== 'removed' && file.patch;
    });
}

async function getFileContent(path) {
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path, ref: `pull/${PR_NUMBER}/head` });
        return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch (e) { return null; }
}

async function analyzeWithGemini(diffData, priorityFilesContext, mode, userQuery = '') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;
    const systemPrompt = loadPrompts(mode, userQuery);

    const payload = {
        contents: [{ parts: [{ text: systemPrompt + "\n\nPR Diff Data:\n" + diffData + "\n\n" + (priorityFilesContext ? "Context:\n" + priorityFilesContext : "") }] }],
        generationConfig: { temperature: 0.1 }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`Gemini API error (${response.status})`);

        const result = await response.json();
        if (!result.candidates || !result.candidates[0].content) return { general_answer: "No AI response.", comments: [] };
        
        let text = result.candidates[0].content.parts[0].text.trim();
        
        const findJSON = (str) => {
            let cleaned = str.replace(/```json/g, '').replace(/```/g, '');
            const firstBrace = cleaned.indexOf('{');
            const lastBrace = cleaned.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) return cleaned.substring(firstBrace, lastBrace + 1);
            const firstBracket = cleaned.indexOf('[');
            const lastBracket = cleaned.lastIndexOf(']');
            if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) return cleaned.substring(firstBracket, lastBracket + 1);
            return null;
        };

        const jsonContent = findJSON(text);
        if (jsonContent) {
            try {
                const parsed = JSON.parse(jsonContent);
                return Array.isArray(parsed) ? { general_answer: "", comments: parsed } : parsed;
            } catch (e) { 
                console.error("[AI] JSON Parse failed. Error:", e.message);
                console.error("[AI] Content that failed to parse (first 1000 chars):");
                console.error(jsonContent.substring(0, 1000));
            }
        } else {
            console.warn("[AI] No JSON-like structure found in response. Raw text snapshot:");
            console.warn(text.substring(0, 500));
        }
        return { general_answer: text, comments: [] };
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`[AI] Timeout after 180s`);
        throw e;
    }
}

async function main() {
    const mode = getReviewMode();
    const userQuery = mode === 'query' ? getUserQuery() : '';
    
    console.log(`On-Demand Assistant started. Mode: ${mode}`);
    await manageReaction('add');

    try {
        const files = await fetchPRFiles();
        if (files.length === 0) return;

        let diffData = "";
        let priorityContext = "";
        for (const file of files) {
            diffData += `--- File: ${file.filename} ---\n${file.patch}\n\n`;
            if (file.filename === 'src/app.js' || file.filename.startsWith('src/core/') || (file.additions + file.deletions) > 100) {
                const content = await getFileContent(file.filename);
                if (content) priorityContext += `### FULL CONTENT OF ${file.filename} ###\n${content}\n\n`;
            }
        }

        const result = await analyzeWithGemini(diffData, priorityContext, mode, userQuery);
        const reviewItems = result.comments || [];
        const generalAnswer = result.general_answer || "";

        if (mode === 'test' && reviewItems.length > 0) {
            console.log("[Process] Processing test files for commit...");
            const createdFiles = [];
            for (const item of reviewItems) {
                if (item.file && item.suggestion) {
                    const dir = path.dirname(item.file);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(item.file, item.suggestion);
                    createdFiles.push(item.file);
                }
            }

            if (createdFiles.length > 0) {
                runCommand(`git add ${createdFiles.join(' ')}`);
                runCommand(`git commit -m "test: add unit tests generated by AI Assistant"`);
                runCommand(`git push origin HEAD`);
                const body = `✅ **AI Assistant**: Added tests for: ${createdFiles.map(f => `\`${f}\``).join(', ')}`;
                if (IS_REVIEW_COMMENT) {
                    await octokit.pulls.createReplyForReviewComment({ owner, repo, pull_number: PR_NUMBER, comment_id: parseInt(COMMENT_ID), body });
                } else {
                    await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body });
                }
                return;
            }
        }

        const prFiles = new Set(files.map(f => f.filename));
        const comments = reviewItems.map(item => {
            if (!prFiles.has(item.file)) return null;
            let body = item.comment;
            if (item.suggestion) body += `\n\n\`\`\`suggestion\n${item.suggestion}\n\`\`\``;
            return { path: item.file, line: parseInt(item.line), body: body };
        }).filter(c => c !== null && !isNaN(c.line));

        let finalBody = `### AI Assistant: ${mode.toUpperCase()}\n\n${generalAnswer}`;

        if (IS_REVIEW_COMMENT) {
            await octokit.pulls.createReplyForReviewComment({ owner, repo, pull_number: PR_NUMBER, comment_id: parseInt(COMMENT_ID), body: finalBody + (comments.length > 0 ? "\n\n*(See suggestions below)*" : "") });
            if (comments.length > 0) await octokit.pulls.createReview({ owner, repo, pull_number: PR_NUMBER, event: 'COMMENT', comments, body: `Specific suggestions based on your query.` });
        } else {
            await octokit.pulls.createReview({ owner, repo, pull_number: PR_NUMBER, event: 'COMMENT', comments: comments.length > 0 ? comments : undefined, body: finalBody });
        }
    } catch (err) {
        console.error("Fatal error:", err);
    } finally {
        await manageReaction('remove');
    }
}

main();
