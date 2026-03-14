# Automate Attendance for Google Meet 

This Chrome extension is designed to streamline participation in online classes. It automates attendance submission through chat code detection and monitoring Gmeet captions to detect verbal roll-calls pattern.

**Background:**

In terms of online classes, many of us prefer watching the recorded lecture later so we can learn at our own pace. However, as our university requires an attendance threshold, so students often join classes mainly to mark their attendance.

During the class, our device is often left on the table while we scroll their phones or do other tasks. This happens specially during on those make-up online classes (specially arranged classes during vacations to cover up the syllabus).

This was not meant to be a serious project-- just a small experiment. When the idea came to mind, I was curious whether the process could be automated the way i was thinking that time, so I built this to see if it was possible specially cracking up the manual roll call one.

---

## Key Features

### Intelligent Chat Monitoring
* **Automated Code Detection**: Watches the Google Meet chat for numeric attendance codes (6-10 digits).
* **Threshold-Based Response**: Automatically types and sends your Student ID once a configurable number of unique codes are detected.
* **Smart Validation**: Ensures codes are only counted once and follows real-time progress via the popup UI.

### Advanced Roll-Call Detector
* **Live Caption Analysis**: Real-time monitoring of Google Meet's built-in captions for keyword triggers like "Yes", "Present", "Yes Sir", or "Yes Ma'am".
* **Siren Alarm System**: Triggers a loud, high-visibility alarm overlay when a spike in caption responses is detected, ensuring you never miss your turn.
* **Auto-Chat Messaging**: Optionally configure a custom message to be automatically sent to the chat when the roll-call starts.
* **Visual Activity Bar**: Live histogram of recent caption events to visualize the "velocity" of responses in the meeting.

---

## Installation

1. **Download** the repository as a ZIP or clone it.
2. Navigate to `chrome://extensions` in your browser.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the extension folder.
5. Pin the extension to your toolbar for easy access.

---

## How to Use

### Attendance by Chat
1. Launch the extension and enter your **Student ID**.
2. Set the **Chat trigger** (default: 5).
3. Click **Start Monitoring**.
4. Keep the Google Meet **Chat panel open** for the extension to interact with the page.

### Roll-Call via Captions
1. Turn on **Live Captions (CC)** in the Google Meet interface.
2. In the extension, toggle the **enable** switch in the Roll-Call Detector section.
3. Configure the **Trigger count** (how many people responding triggers the alarm) and **Window** (time in seconds).
4. The alarm will fire automatically. Click **Dismiss Alarm** to reset all states when finished.

---

## Challenges & Technical Journey

Building a reliable automation tool for a platform as complex as Google Meet presented several significant challenges. Here is the evolution of the project:

### Phase 1: Grid Monitoring (Failed) 
Initially, the goal was to detect roll-call by monitoring the "Mic Button" icons of other participants in the grid. If many icons turned red or white in a short period, it might indicate a roll-call.
* **The Issue**: Meet's DOM is extremely dynamic and uses obfuscated class names. Tracking hundreds of changing elements in real-time caused significant performance lag and was unreliable across different grid layouts.

### Phase 2: Audio Level Detection (Failed) 
The second attempt involved using the Web Audio API to detect volume spikes in the meeting audio.
* **The Issue**: Modern browser security policies (CORS and MediaStream restrictions) prevent extensions from easily accessing the internal audio streams of a separate tab without invasive permissions and constant user prompts, which ruined the "seamless" experience.

### Phase 3: Live Caption Integration (Success) 
Finally, I noticed that Gmeet introduced a new feature of live captions.So, the decision was made to leverage Meet's own **Live Captions** this time. 
* **The Solution**: By observing the DOM elements specifically dedicated to captions, the extension can perform clean, high-accuracy text analysis. This method proved to be the most robust, as it works regardless of the user's grid layout and respects privacy by only "reading" what is already visible to the user as text.

---

## Tech Stack
* **Core**: JavaScript (Content Scripts, Popup Logic)
* **UI**: HTML5, CSS3 (Modern HSL Design Tokens)
* **APIs**: Chrome Extension API (Storage, Messaging), Web Audio API (Siren Generation), MutationObservers (DOM Interaction)

---

## ⚖️ License 
While giving the MIT License , this project is intended for learning purposes only. So, kindly always comply with your institution's attendance policies.
