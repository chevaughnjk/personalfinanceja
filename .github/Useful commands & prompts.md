**Useful commands & Prompts**



**File Tree Creation:**

Get-ChildItem-Recurse -Force | Where-Object { $_.FullName -notmatch '\\(node_modules|\.git)(\\|$)' } |Sort-Object FullName | ForEach-Object { $depth =($_.FullName.Substring((Get-Location).Path.Length).TrimStart('\') -split '\\').Count - 1; ('| ' * $depth) + '|-- ' + $_.Name +$(if(-not $_.PSIsContainer){" -> $($_.FullName)"}) } | Out-Filefile-tree.txt



**GithubCommit:**

git add -A

git commit --amend--no-edit

git push -f originmain



**Triaging improvement prompt:**

****

Yes,I agree with all of this, and I want it fully implemented now as the mostrobust, complete version, no short-term or piecemeal fixes anywhere.

* Before writing anything, read the actual current files fresh from disk rather than relying on memory or partial extracts pulled earlier, and use good judgement throughout: don't take the narrowest reading of a request when a more complete, more robust solution is clearly the right call.
* Always tell me plainly if something is missing, and if you're ever unsure, provide the PowerShell search commands needed to confirm it rather than guessing.

**Whileworking through this, always look for at least three other related issues,inconsistencies, or genuine improvement opportunities along the way, evenoutside the specific scope of what I originally asked, and build them directlyinto the finished implementation rather than just flagging them for later.**

* **Every solution should come from genuinely consumer-first, first-principles thinking: start from what actually serves the person using this app, not from what's convenient to patch or already exists, and build the real, complete solution from that foundation.**
* **Use your own judgement throughout, if something is clearly the right improvement and fits everything already established about this product, make the call and implement it directly rather than stopping to ask me.**
* **Only come back to me when something is genuinely ambiguous or requires a decision only I can make.**

The process itself must always follow three completely separate,sequential steps, never blended together in one response:

1. Thinking round - plain-text reasoning only. No code, no implementation, no diffs. Just the actual thought process, until I explicitly say to move on.
2. Evidence-gathering round - once thinking is done, ask for everything needed from the codebase in one consolidated request, whether that's specific files, greps, or Select-String output. Map every affected file, call site, and likely knock-on effect before considering the plan complete.
3. Implementation round - only once the evidence is genuinely sufficient, provide complete, exact, copy-paste-ready before-and-after diffs for every affected file, inline in the chat, never as a downloadable attachment. No omitted lines, no placeholders like * or ..., no commentary, no reasoning, no surroundi explanation of any kind, just the pure before-and-after code. Match existing indentation, formatting, and naming exactly, don't add new comments into the code, strip any personal or identifying information, and give full, complete function bodies only. If the evidence turns out to be insufficient, ask only for the specific missing piece and don't attempt the diffs until you have it.

Apply this exact separation every time going forward, not just for this instance.

Neverexplain anything to me using technical or engineering language. I'm a productand user-journey owner, not a technical architect, so explain everything younotice or recommend in plain, everyday language, and hold that standard forevery response from here on.

Finally,one standing design principle for this app overall:

* the whole experience should be compact, with tiles sitting beside each other wherever possible, rendering together cleanly and aesthetically rather than just being crammed in.
* Aesthetics come first, functionality second.
* Anything that can reasonably have a visual or graphic representation should have one, there should never be a plain, vanilla, text-only experience anywhere in this app.
