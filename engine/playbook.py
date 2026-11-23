"""Short-form rules the engine gives every AI CLI, and the checks it runs on what comes back.

The rules are adapted from the YouTube agent skills by Jake Schincariol (MIT licence,
https://github.com/jakeschincariol/youtube-agent-skill): yt-shorts (what makes a moment stand on its
own), yt-package (title and on-screen text as one pairing, linted for truncation, vagueness and
repetition) and yt-seo (the query a real viewer types). yt-viral's ranking lives in finder.py.

The skills are written for a person in a chat. Here they are rewritten as prompt rules plus
deterministic checks, so they work with every supported CLI and never wait for an answer.
"""

import re

SHORTS_RULES = (
    "A Short must survive without the video around it. Prefer spans where all three are true: "
    "the first sentence is a complete thought that needs no earlier context; there is a turn, such as a "
    "setup and its punchline, or a claim and the line that proves or flips it; and it ends on a strong line, "
    "not a trail-off. Score lower when any of the three is missing. "
)

PACKAGING_RULES = (
    "Treat the title and hookText as one pairing. title: at most 60 characters, ideally under 40 so the "
    "subject survives a mobile feed; put the subject in the first three words; a name, number or concrete "
    "detail beats an adjective; no hype words such as insane, crazy or best; at most two all-caps words. "
    "hookText: 2 to 4 words shown on screen for the first two seconds. It must make a scrolling viewer stay, "
    "and it must use different words from the title. searchQuery: the search a real viewer would type to "
    "find this clip. Use most of its words in the title or the first sentence of the description. description: the "
    "first sentence says what the viewer gets, in the words they would type. tags: up to 8 names, spellings "
    "and terms people actually search for. "
)

TITLE_DESKTOP = 60
# yt-package's title.py flags on-screen text over four words: at feed size a fifth word is a grey smear.
HOOK_WORDS = (2, 4)

# English and common Roman Hindi function words. They do not count as the subject of a title.
STOP = {
    "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "is", "are", "with", "your", "you", "my", "i",
    "this", "that", "it", "how", "what", "why", "when", "was", "be", "me", "we", "so",
    "hai", "hain", "ho", "ka", "ki", "ke", "ko", "se", "mein", "me", "par", "pe", "aur", "ya", "ye", "yeh", "wo",
    "woh", "toh", "to", "bhi", "hi", "na", "nahi", "kya", "kyun", "kaise", "jab", "ab", "tha", "thi", "the",
    "mera", "meri", "mere", "tera", "teri", "apna", "apni", "ek", "sab", "bas",
}
VAGUE = {
    "amazing", "incredible", "insane", "crazy", "huge", "massive", "ultimate", "best", "powerful", "secret",
    "revolutionary", "mindblowing", "epic", "perfect", "complete", "everything", "unbelievable", "shocking",
}


def words(text):
    return re.findall(r"[a-z0-9']+", text.lower())


def subject_words(text):
    return {word for word in words(text) if word not in STOP and len(word) > 1}


def niche_rule(niche):
    niche = " ".join(str(niche or "").split())[:80]
    if not niche:
        return ""
    guidance = f"The channel niche is {niche}. Prefer moments its audience would share. "
    if re.search(r"stand[ -]?up|crowd work", niche, re.I):
        guidance += ("For stand-up and crowd work, keep the question or premise, the comic's response, and the punchline. "
                     "Keep a short audience reaction where it lands the joke. Preserve Hindi and English code-switching. "
                     "The title and opening text can tease the premise without giving away the punchline. ")
    return guidance


def packaging_issues(fields):
    """Return the yt-package and yt-seo checks a title, hook and description fail, as sentences for the CLI."""
    title = fields.get("title", "")
    hook = fields.get("hookText", "")
    query = fields.get("searchQuery", "")
    description = fields.get("description", "")
    issues = []
    if len(title) > TITLE_DESKTOP:
        issues.append(f"Shorten the title to {TITLE_DESKTOP} characters or fewer; it is {len(title)}.")
    shouting = [word for word in title.split() if len(word) > 2 and word.isupper()]
    if len(shouting) > 2:
        issues.append("Use at most two all-caps words in the title.")
    vague = sorted(set(words(title)) & VAGUE)
    if vague:
        issues.append(f"Replace the vague word {', '.join(vague)} in the title with a name, number or concrete detail.")
    if words(title) and not subject_words(" ".join(words(title)[:3])):
        issues.append("Move the subject into the first three words of the title.")
    if not hook:
        issues.append(f"Add hookText: {HOOK_WORDS[0]} to {HOOK_WORDS[1]} words of on-screen text for the first two seconds.")
    else:
        count = len(hook.split())
        if not HOOK_WORDS[0] <= count <= HOOK_WORDS[1]:
            issues.append(f"Write hookText in {HOOK_WORDS[0]} to {HOOK_WORDS[1]} words; it has {count}.")
        shared = sorted(subject_words(hook) & subject_words(title))
        if shared:
            issues.append(f"hookText repeats the title on {', '.join(shared)}. Use different words with the same promise.")
    if not query:
        issues.append("Add searchQuery: the search a real viewer would type to find this clip.")
    else:
        # yt-seo's query test: the title and the opening line carry the words of the query. Most of them is
        # enough, so a spelling variant or a dropped word does not cost a rewrite.
        opening = re.split(r"(?<=[.!?])\s", description, maxsplit=1)[0]
        wanted = subject_words(query)
        missing = sorted(wanted - subject_words(title + " " + opening))
        if wanted and len(missing) * 2 >= len(wanted):
            issues.append(f"Use more of the searchQuery words in the title or the first sentence of the description; "
                          f"missing {', '.join(missing)}.")
    return issues
