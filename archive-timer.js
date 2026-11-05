// archive-timer.js — timers in a dedicated worker are exempt from Chrome's
// intensive throttling of hidden tabs, which would otherwise stretch every
// pause in a long archive run to a full minute.
onmessage = (event) => setTimeout(() => postMessage(event.data.id), event.data.ms);
