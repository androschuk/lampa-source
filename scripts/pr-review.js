#!/usr/bin/env node

import { Octokit } from "@octokit/rest";
import fs from 'fs';
import path from 'path';

/**
 * On-Demand Smart Code Review Script
 * 
 * This script is triggered by a GitHub Action when a comment '/ai review [mode]' is made on a PR.
 * It analyzes the PR changes using a Gemini model and posts inline review comments.
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PR_NUMBER = parseInt(process.env.PR_NUMBER);
const REPO_FULL_NAME = process.env.REPO_FULL_NAME;
const COMMENT_BODY = process.env.COMMENT_BODY || '';
const COMMENT_ID = process.env.COMMENT_ID;
const MODEL_NAME = "gemma-4-31b-it";

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
 * Loads the system prompt and instructions from the skill file.
 */
function loadPrompts(mode) {
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

        const modeInstructions = {
            secure: secureInst,
            perf: perfInst,
            default: defaultInst
        };

        const inst = modeInstructions[mode] || modeInstructions.default;
        
        return systemPromptTemplate
            .replace('{{mode}}', mode)
            .replace('{{modeInstructions}}', inst);
    } catch (e) {
        console.error(`Error loading prompts from ${skillPath}: ${e.message}`);
        return `Perform a code review for mode: ${mode}. Return JSON.`;
    }
}

/**
 * Manages the 'eyes' reaction on the triggering comment.
 */
async function manageReaction(action) {
    try {
        if (action === 'add') {
            await octokit.reactions.createForIssueComment({
                owner,
                repo,
                comment_id: COMMENT_ID,
                content: 'eyes',
            });
        } else if (action === 'remove') {
            const { data: reactions } = await octokit.reactions.listForIssueComment({
                owner,
                repo,
                comment_id: COMMENT_ID,
            });
            const eyesReaction = reactions.find(r => r.content === 'eyes' && r.user.login.includes('github-actions'));
            if (eyesReaction) {
                await octokit.reactions.deleteForIssueComment({
                    owner,
                    repo,
                    comment_id: COMMENT_ID,
                    reaction_id: eyesReaction.id,
                });
            }
        }
    } catch (e) {
        console.warn(`Warning: Failed to ${action} reaction: ${e.message}`);
    }
}

/**
 * Parses the review mode from the comment body.
 */
function getReviewMode() {
    const modeMatch = COMMENT_BODY.match(/\/ai review\s+(\w+)/);
    return modeMatch ? modeMatch[1] : 'default';
}

/**
 * Fetches the list of files in the PR and their patches.
 */
async function fetchPRFiles() {
    console.log(`Fetching files for PR #${PR_NUMBER}...`);
    const { data: files } = await octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: PR_NUMBER,
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
            owner,
            repo,
            path,
            ref: `pull/${PR_NUMBER}/head`
        });
        return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch (e) {
        console.warn(`Warning: Failed to fetch full content for ${path}: ${e.message}`);
        return null;
    }
}

/**
 * Calls the Gemini API with the specified model to analyze the code.
 */
async function analyzeWithGemini(diffData, priorityFilesContext, mode) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;
    const systemPrompt = loadPrompts(mode);

    const userPrompt = `
PR Diff Data:
${diffData}

${priorityFilesContext ? `Full Context for Priority Files:\n${priorityFilesContext}` : ''}

Analyze the changes and provide your review in the specified JSON format.
`;

    console.log(`[AI] Sending request to Gemini (${MODEL_NAME})...`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-goog-api-key': GEMINI_API_KEY
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: systemPrompt + "\n\n" + userPrompt }]
                }],
                generationConfig: {
                    temperature: 0.1,
                }
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini API error (${response.status}): ${errorText}`);
        }

        const result = await response.json();
        if (!result.candidates || !result.candidates[0].content) {
            console.error("[AI] Error: Empty response from model");
            return [];
        }
        
        let text = result.candidates[0].content.parts[0].text.trim();
        
        // Cleanup if the model ignored instructions and added markdown blocks
        text = text.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();

        try {
            if (!text || text === "[]") return [];
            if (text.startsWith('[')) return JSON.parse(text);
            
            if (text.toLowerCase().includes("no issues") || text.toLowerCase().includes("looks good")) {
                console.log("[AI] Plain text response indicates no issues.");
                return [];
            }

            console.warn("[AI] Unexpected text response, returning empty array.");
            return [];
        } catch (e) {
            console.error("[AI] Failed to parse JSON. Raw output snapshot:");
            console.error(text.substring(0, 500));
            return [];
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new Error(`[AI] Request timed out after 120s`);
        }
        throw e;
    }
}

/**
 * Main execution flow.
 */
async function main() {
    const mode = getReviewMode();
    console.log(`On-Demand Review started. Mode: ${mode}`);

    await manageReaction('add');

    try {
        const files = await fetchPRFiles();
        if (files.length === 0) {
            console.log("[Process] No relevant files found for review.");
            return;
        }
        console.log(`[Process] Found ${files.length} files to analyze.`);

        let diffData = "";
        let priorityFilesContext = "";

        for (const file of files) {
            console.log(`[Process] Adding diff: ${file.filename} (+${file.additions}/-${file.deletions})`);
            diffData += `--- File: ${file.filename} ---\n${file.patch}\n\n`;
            
            const isCore = file.filename === 'src/app.js' || file.filename.startsWith('src/core/');
            const isComplex = file.changes > 100;

            if (isCore || isComplex) {
                console.log(`[Process] Priority file detected, fetching full content: ${file.filename}`);
                const content = await getFileContent(file.filename);
                if (content) {
                    priorityFilesContext += `### FULL CONTENT OF ${file.filename} ###\n${content}\n\n`;
                }
            }
        }

        const reviewItems = await analyzeWithGemini(diffData, priorityFilesContext, mode);

        if (!Array.isArray(reviewItems) || reviewItems.length === 0) {
            console.log("[AI] No issues found. Posting positive review...");
            await octokit.pulls.createReview({
                owner,
                repo,
                pull_number: PR_NUMBER,
                event: 'COMMENT',
                body: `✅ **Code Review** completed.\n\nNo significant issues were found. The code looks good! 🚀`
            });
            return;
        }

        console.log(`[AI] Found ${reviewItems.length} issues. Preparing review...`);

        const prFiles = new Set(files.map(f => f.filename));
        const comments = reviewItems.map(item => {
            if (!prFiles.has(item.file)) {
                console.warn(`Warning: AI suggested comment for file not in PR: ${item.file}`);
                return null;
            }
            let body = item.comment;
            if (item.suggestion) {
                body += `\n\n\`\`\`suggestion\n${item.suggestion}\n\`\`\``;
            }
            return {
                path: item.file,
                line: parseInt(item.line),
                body: body
            };
        }).filter(c => c !== null && !isNaN(c.line));

        if (comments.length === 0) {
            console.log("No valid comments to post.");
            return;
        }

        await octokit.pulls.createReview({
            owner,
            repo,
            pull_number: PR_NUMBER,
            event: 'COMMENT',
            comments: comments,
            body: `Smart Code Review completed in **${mode}** mode using ${MODEL_NAME}.`
        });

        console.log("Review successfully posted to GitHub.");
    } finally {
        await manageReaction('remove');
    }
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
