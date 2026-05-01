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
        } else if (action === 'complete') {
            await manageReaction('remove');
            await octokit.reactions.createForIssueComment({ owner, repo, comment_id: COMMENT_ID, content: '+1' });
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
        system_instruction: {
            parts: [{ text: systemPrompt }]
        },
        contents: [{ 
            role: "user",
            parts: [{ text: "CRITICAL: Return ONLY JSON object. No preamble, no thoughts, no explanation. Just JSON.\n\nPR Diff Data:\n" + diffData + "\n\n" + (priorityFilesContext ? "Context:\n" + priorityFilesContext : "") }] 
        }],
        generationConfig: { 
            temperature: 0.1,
            response_mime_type: "application/json"
        }
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

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini API error (${response.status}): ${errText}`);
        }

        const result = await response.json();
        if (!result.candidates || !result.candidates[0].content) return { general_answer: "No AI response.", comments: [] };
        
        let text = result.candidates[0].content.parts[0].text.trim();
        
        // Advanced JSON extraction: Find the most complete JSON object in the text
        const extractJSON = (str) => {
            const firstOpen = str.indexOf('{');
            const lastClose = str.lastIndexOf('}');
            if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
                const candidate = str.substring(firstOpen, lastClose + 1);
                try {
                    return JSON.parse(candidate);
                } catch (e) {
                    // If simple slice fails, try to find a valid JSON object by iterating backwards from the end
                    let end = lastClose;
                    while (end > firstOpen) {
                        try {
                            const chunk = str.substring(firstOpen, end + 1);
                            return JSON.parse(chunk);
                        } catch (err) {
                            end = str.lastIndexOf('}', end - 1);
                        }
                    }
                }
            }
            return null;
        };

        const parsed = extractJSON(text);
        if (parsed) {
            // Log non-JSON parts as thoughts if they exist
            const jsonStr = JSON.stringify(parsed);
            if (text.length > jsonStr.length + 20) {
                console.log("[AI Thoughts]:", text.replace(jsonStr, '').trim());
            }
            return Array.isArray(parsed) ? { general_answer: "", comments: parsed } : parsed;
        }

        console.warn("[AI] Failed to parse JSON. Raw output logged as general_answer.");
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
        if (files.length === 0) {
            console.log("No files to review.");
            await manageReaction('complete');
            return;
        }

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
        
        if (result.general_answer && result.general_answer !== "No issues found") {
            console.log("[AI Reasoning/Summary]:", result.general_answer);
        }

        const reviewItems = result.comments || [];

        if (mode === 'test') {
            if (reviewItems.length > 0) {
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
                }
            } else {
                const body = "❌ **AI Assistant**: Failed to generate tests. Please check logs.";
                if (IS_REVIEW_COMMENT) {
                    await octokit.pulls.createReplyForReviewComment({ owner, repo, pull_number: PR_NUMBER, comment_id: parseInt(COMMENT_ID), body });
                } else {
                    await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body });
                }
            }
            await manageReaction('complete');
            return;
        }

        const prFiles = new Set(files.map(f => f.filename));
        const comments = reviewItems.map(item => {
            if (!prFiles.has(item.file)) return null;
            let body = item.comment;
            if (item.suggestion) {
                let suggestion = item.suggestion.trim();
                if (!suggestion.startsWith('```')) {
                    suggestion = `\`\`\`suggestion\n${suggestion}\n\`\`\``;
                }
                body += `\n\n${suggestion}`;
            }
            return { path: item.file, line: parseInt(item.line), side: 'RIGHT', body: body };
        }).filter(c => c !== null && !isNaN(c.line) && c.line > 0);

        if (comments.length > 0) {
            await octokit.pulls.createReview({ 
                owner, 
                repo, 
                pull_number: PR_NUMBER, 
                event: 'COMMENT', 
                comments
            });
        } else {
            console.log("No issues found in the JSON comments array.");
            const body = "✅ **Code Review completed.**\nNo significant issues were found.";
            if (IS_REVIEW_COMMENT) {
                await octokit.pulls.createReplyForReviewComment({ owner, repo, pull_number: PR_NUMBER, comment_id: parseInt(COMMENT_ID), body });
            } else {
                await octokit.issues.createComment({ owner, repo, issue_number: PR_NUMBER, body });
            }
        }

        await manageReaction('complete');
    } catch (err) {
        console.error("Fatal error:", err);
        await manageReaction('remove');
    }
}

main();
