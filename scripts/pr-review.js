#!/usr/bin/env node

import { Octokit } from "@octokit/rest";
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * On-Demand Smart Code Review Script
 * 
 * This script is triggered by a GitHub Action when a comment starting with '/ai ' is made on a PR.
 * It analyzes the PR changes using a Gemini model and posts inline review comments or commits tests.
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
    console.error("Error: Missing required environment variables (GITHUB_TOKEN, GEMINI_API_KEY, PR_NUMBER, REPO_FULL_NAME, COMMENT_ID)");
    process.exit(1);
}

const [owner, repo] = REPO_FULL_NAME.split("/");
const octokit = new Octokit({ auth: GITHUB_TOKEN });

const IGNORED_PATHS = [
    'src/lang/',
    '.github/dependabot.yml',
    'package-lock.json',
    'dist/',
    'build/'
];

/**
 * Executes a shell command and returns output.
 */
function runCommand(command) {
    try {
        console.log(`[Shell] Executing: ${command}`);
        return execSync(command, { encoding: 'utf8', stdio: 'inherit' });
    } catch (e) {
        console.error(`[Shell Error] Command failed: ${command}`);
        console.error(e.message);
        throw e;
    }
}

/**
 * Loads the system prompt and instructions from the skill file.
 */
function loadPrompts(mode, userQuery = '') {
    const skillPath = path.join(process.cwd(), '.gemini/skills/code-review-prompts/SKILL.md');
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
        const testInst = extractSection('MODE_INSTRUCTIONS_TEST');
        const queryInst = extractSection('MODE_INSTRUCTIONS_QUERY');

        const modeInstructions = {
            secure: secureInst,
            perf: perfInst,
            test: testInst,
            query: queryInst,
            default: defaultInst
        };

        const inst = modeInstructions[mode] || modeInstructions.default;
        
        return systemPromptTemplate
            .replace('{{mode}}', mode)
            .replace('{{modeInstructions}}', inst)
            .replace('{{userQuery}}', userQuery);
    } catch (e) {
        console.error(`[Error] Failed to load prompts: ${e.message}`);
        return `Perform a code review for mode: ${mode}. Return JSON with "general_answer" and "comments".`;
    }
}

/**
 * Manages the 'eyes' reaction on the triggering comment.
 */
async function manageReaction(action) {
    try {
        if (action === 'add') {
            await octokit.reactions.createForIssueComment({
                owner, repo, comment_id: COMMENT_ID, content: 'eyes',
            });
        } else if (action === 'remove') {
            const { data: reactions } = await octokit.reactions.listForIssueComment({
                owner, repo, comment_id: COMMENT_ID,
            });
            const eyesReaction = reactions.find(r => r.content === 'eyes' && r.user.login.includes('github-actions'));
            if (eyesReaction) {
                await octokit.reactions.deleteForIssueComment({
                    owner, repo, comment_id: COMMENT_ID, reaction_id: eyesReaction.id,
                });
            }
        }
    } catch (e) {
        console.warn(`Warning: Failed to ${action} reaction: ${e.message}`);
    }
}

/**
 * Parses the review mode and user query from the comment body.
 */
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

/**
 * Fetches the list of files in the PR and their patches.
 */
async function fetchPRFiles() {
    const { data: files } = await octokit.pulls.listFiles({
        owner, repo, pull_number: PR_NUMBER,
    });
    return files.filter(file => {
        const isIgnored = IGNORED_PATHS.some(ignored => file.filename.startsWith(ignored));
        return !isIgnored && file.status !== 'removed' && file.patch;
    });
}

/**
 * Fetches the full content of a file from the PR head.
 */
async function getFileContent(path) {
    try {
        const { data } = await octokit.repos.getContent({
            owner, repo, path, ref: `pull/${PR_NUMBER}/head`
        });
        return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch (e) {
        return null;
    }
}

/**
 * Calls the Gemini API with the specified model to analyze the code.
 */
async function analyzeWithGemini(diffData, priorityFilesContext, mode, userQuery = '') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;
    const systemPrompt = loadPrompts(mode, userQuery);

    const userPrompt = `
PR Diff Data:
${diffData}

${priorityFilesContext ? `Full Context for Priority Files:\n${priorityFilesContext}` : ''}

Analyze the changes and provide your response in the specified JSON format.
`;

    console.log(`[AI] Sending request to Gemini (${MODEL_NAME})...`);
    const payload = {
        contents: [{
            parts: [{ text: systemPrompt + "\n\n" + userPrompt }]
        }],
        generationConfig: { temperature: 0.1 }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-goog-api-key': GEMINI_API_KEY
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini API error (${response.status}): ${errorText}`);
        }

        const result = await response.json();
        if (!result.candidates || !result.candidates[0].content) {
            return { general_answer: "I encountered an internal error and could not generate a response.", comments: [] };
        }
        
        let text = result.candidates[0].content.parts[0].text.trim();
        
        // Advanced JSON extraction: find the first { or [ and the last } or ]
        const findJSON = (str) => {
            const firstBrace = str.indexOf('{');
            const firstBracket = str.indexOf('[');
            let start = -1;
            let end = -1;

            if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
                start = firstBrace;
                end = str.lastIndexOf('}');
            } else if (firstBracket !== -1) {
                start = firstBracket;
                end = str.lastIndexOf(']');
            }

            if (start !== -1 && end !== -1 && end > start) {
                return str.substring(start, end + 1);
            }
            return null;
        };

        const jsonContent = findJSON(text);
        if (jsonContent) {
            try {
                const parsed = JSON.parse(jsonContent);
                if (Array.isArray(parsed)) return { general_answer: "", comments: parsed };
                return parsed;
            } catch (e) {
                console.error("[AI] Failed to parse extracted JSON block. Error:", e.message);
                console.error("[AI] Extracted block snapshot (first 500 chars):");
                console.error(jsonContent.substring(0, 500));
            }
        } else {
            console.warn("[AI] No JSON structure ({ or [) found in the response.");
        }

        // Fallback to text analysis if no JSON found
        if (text.toLowerCase().includes("no issues") || text.toLowerCase().includes("looks good")) {
            return { general_answer: "", comments: [] };
        }
        return { general_answer: text, comments: [] };
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`[AI] Request timed out after 180s`);
        throw e;
    }
}

/**
 * Main execution flow.
 */
async function main() {
    const mode = getReviewMode();
    const userQuery = mode === 'query' ? getUserQuery() : '';
    
    console.log(`On-Demand Assistant started. Mode: ${mode}`);
    await manageReaction('add');

    try {
        const files = await fetchPRFiles();
        if (files.length === 0) return;

        let diffData = "";
        let priorityFilesContext = "";

        for (const file of files) {
            diffData += `--- File: ${file.filename} ---\n${file.patch}\n\n`;
            const isCore = file.filename === 'src/app.js' || file.filename.startsWith('src/core/');
            const isComplex = (file.additions + file.deletions) > 100;
            if (isCore || isComplex) {
                const content = await getFileContent(file.filename);
                if (content) priorityFilesContext += `### FULL CONTENT OF ${file.filename} ###\n${content}\n\n`;
            }
        }

        const result = await analyzeWithGemini(diffData, priorityFilesContext, mode, userQuery);
        const reviewItems = result.comments || [];
        const generalAnswer = result.general_answer || "";

        if (reviewItems.length === 0 && !generalAnswer) {
            const body = `✅ **AI Assistant** finished. No issues found.`;
            if (IS_REVIEW_COMMENT) {
                await octokit.pulls.createReplyForReviewComment({ owner, repo, pull_number: PR_NUMBER, comment_id: parseInt(COMMENT_ID), body });
            } else {
                await octokit.pulls.createReview({ owner, repo, pull_number: PR_NUMBER, event: 'COMMENT', body });
            }
            return;
        }

        // SPECIAL LOGIC FOR ADD TEST: Commit files instead of commenting
        if (mode === 'test') {
            console.log(`[Process] Processing ${reviewItems.length} items for test commit...`);
            const createdFiles = [];
            for (const item of reviewItems) {
                console.log(`[Debug] Item: file=${item.file}, hasSuggestion=${!!item.suggestion}`);
                if (item.file && item.suggestion) {
                    const filePath = item.file;
                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(filePath, item.suggestion);
                    createdFiles.push(filePath);
                    console.log(`[Process] Created test file: ${filePath}`);
                }
            }

            if (createdFiles.length > 0) {
                runCommand(`git add ${createdFiles.join(' ')}`);
                runCommand(`git commit -m "test: add unit tests generated by AI Assistant"`);
                runCommand(`git push origin HEAD`);
                
                const summary = createdFiles.map(f => `\`${f}\``).join(', ');
                const body = `✅ **AI Assistant**: Added tests for the following files: ${summary}`;
                
                if (IS_REVIEW_COMMENT) {
                    await octokit.pulls.createReplyForReviewComment({ owner, repo, pull_number: PR_NUMBER, comment_id: parseInt(COMMENT_ID), body });
                } else {
                    await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body });
                }
                console.log("[Process] Tests committed and pushed.");
            } else {
                console.warn("[Process] No files were created from AI response. Check the debug logs above.");
                // We stay silent in the PR comments to avoid noise if AI failed to format properly
            }
            return;
        }

        // REGULAR LOGIC FOR REVIEW/QUERY
        const prFiles = new Set(files.map(f => f.filename));
        const comments = reviewItems.map(item => {
            if (!prFiles.has(item.file)) return null;
            let body = item.comment;
            if (item.suggestion) body += `\n\n\`\`\`suggestion\n${item.suggestion}\n\`\`\``;
            return { path: item.file, line: parseInt(item.line), body: body };
        }).filter(c => c !== null && !isNaN(c.line));

        let finalBody = `### AI Assistant: ${mode.toUpperCase()}\n\n`;
        if (generalAnswer) finalBody += `${generalAnswer}\n\n`;
        finalBody += `*Using ${MODEL_NAME}*`;

        if (IS_REVIEW_COMMENT) {
            await octokit.pulls.createReplyForReviewComment({
                owner, repo, pull_number: PR_NUMBER, comment_id: parseInt(COMMENT_ID),
                body: finalBody + (comments.length > 0 ? "\n\n*(See inline suggestions below)*" : "")
            });
            if (comments.length > 0) {
                await octokit.pulls.createReview({ owner, repo, pull_number: PR_NUMBER, event: 'COMMENT', comments, body: `Specific suggestions based on your query.` });
            }
        } else {
            await octokit.pulls.createReview({ owner, repo, pull_number: PR_NUMBER, event: 'COMMENT', comments: comments.length > 0 ? comments : undefined, body: finalBody });
        }

        console.log("[Process] Response successfully posted to GitHub.");
    } catch (err) {
        console.error("Fatal error:", err);
        throw err;
    } finally {
        await manageReaction('remove');
    }
}

main().catch(err => {
    console.error("Critical script failure:", err.message);
    process.exit(1);
});
