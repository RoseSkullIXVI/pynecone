// State management for Pynecone web apps.
import axios from "axios";
import io from "socket.io-client";
import JSON5 from "json5";
import env from "env.json";

// Endpoint URLs.
const PINGURL = env.pingUrl
const EVENTURL = env.eventUrl
const UPLOADURL = env.uploadUrl

// Global variable to hold the token.
let token;

// Key for the token in the session storage.
const TOKEN_KEY = "token";

// Dictionary holding component references.
export const refs = {};

/**
 * Generate a UUID (Used for session tokens).
 * Taken from: https://stackoverflow.com/questions/105034/how-do-i-create-a-guid-uuid
 * @returns A UUID.
 */
const generateUUID = () => {
  let d = new Date().getTime(),
    d2 = (performance && performance.now && performance.now() * 1000) || 0;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    let r = Math.random() * 16;
    if (d > 0) {
      r = (d + r) % 16 | 0;
      d = Math.floor(d / 16);
    } else {
      r = (d2 + r) % 16 | 0;
      d2 = Math.floor(d2 / 16);
    }
    return (c == "x" ? r : (r & 0x7) | 0x8).toString(16);
  });
};

/**
 * Get the token for the current session.
 * @returns The token.
 */
export const getToken = () => {
  if (token) {
    return token;
  }
  if (window) {
    if (!window.sessionStorage.getItem(TOKEN_KEY)) {
      window.sessionStorage.setItem(TOKEN_KEY, generateUUID());
    }
    token = window.sessionStorage.getItem(TOKEN_KEY);
  }
  return token;
};

/**
 * Apply a delta to the state.
 * @param state The state to apply the delta to.
 * @param delta The delta to apply.
 */
export const applyDelta = (state, delta) => {
  for (const substate in delta) {
    let s = state;
    const path = substate.split(".").slice(1);
    while (path.length > 0) {
      s = s[path.shift()];
    }
    for (const key in delta[substate]) {
      s[key] = delta[substate][key];
    }
  }
};

/**
 * Send an event to the server.
 * @param event The event to send.
 * @param router The router object.
 * @param socket The socket object to send the event on.
 *
 * @returns True if the event was sent, false if it was handled locally.
 */
export const applyEvent = async (event, router, socket) => {
  // Handle special events
  if (event.name == "_redirect") {
    router.push(event.payload.path);
    return false;
  }

  if (event.name == "_console") {
    console.log(event.payload.message);
    return false;
  }

  if (event.name == "_alert") {
    alert(event.payload.message);
    return false;
  }

  if (event.name == "_set_focus") {
    const ref =
      event.payload.ref in refs ? refs[event.payload.ref] : event.payload.ref;
    ref.current.focus();
    return false;
  }

  if (event.name == "_set_value") {
    const ref =
      event.payload.ref in refs ? refs[event.payload.ref] : event.payload.ref;
    ref.current.value = event.payload.value;
    return false;
  }

  // Send the event to the server.
  event.token = getToken();
  event.router_data = (({ pathname, query }) => ({ pathname, query }))(router);
  if (socket) {
    socket.emit("event", JSON.stringify(event));
    return true;
  }

  return false;
};

/**
 * Process an event off the event queue.
 * @param event The current event
 * @param state The state with the event queue.
 * @param setResult The function to set the result.
 */
export const applyRestEvent = async (event, state, setResult) => {
  let eventSent = false;
  if (event.handler == "uploadFiles") {
    eventSent = await uploadFiles(state, setResult, event.name);
  }
  if (!eventSent) {
    // If no event was sent, set processing to false and return.
    setResult({ ...state, processing: false });
  }
};

/**
 * Process an event off the event queue.
 * @param state The state with the event queue.
 * @param setState The function to set the state.
 * @param result The current result.
 * @param setResult The function to set the result.
 * @param router The router object.
 * @param socket The socket object to send the event on.
 */
export const updateState = async (
  state,
  setState,
  result,
  setResult,
  router,
  socket
) => {
  // If we are already processing an event, or there are no events to process, return.
  if (result.processing || state.events.length == 0) {
    return;
  }

  // Set processing to true to block other events from being processed.
  setResult({ ...result, processing: true });

  // Pop the next event off the queue and apply it.
  const event = state.events.shift();
  // Set new events to avoid reprocessing the same event.
  setState({ ...state, events: state.events });

  // Process events with handlers via REST and all others via websockets.
  if (event.handler) {
    await applyRestEvent(event, state, setResult);
  } else {
    const eventSent = await applyEvent(event, router, socket);
    if (!eventSent) {
      // If no event was sent, set processing to false and return.
      setResult({ ...state, processing: false });
    }
  }
};

/**
 * Connect to a websocket and set the handlers.
 * @param socket The socket object to connect.
 * @param state The state object to apply the deltas to.
 * @param setState The function to set the state.
 * @param result The current result.
 * @param setResult The function to set the result.
 * @param endpoint The endpoint to connect to.
 * @param transports The transports to use.
 */
export const connect = async (
  socket,
  state,
  setState,
  result,
  setResult,
  router,
  transports,
  setNotConnected
) => {
  // Get backend URL object from the endpoint
  const endpoint = new URL(EVENTURL);
  // Create the socket.
  socket.current = io(EVENTURL, {
    path: endpoint["pathname"],
    transports: transports,
    autoUnref: false,
  });

  // Once the socket is open, hydrate the page.
  socket.current.on("connect", () => {
    updateState(state, setState, result, setResult, router, socket.current);
    setNotConnected(false)
  });

  socket.current.on('connect_error', (error) => {
    setNotConnected(true)
  });

  // On each received message, apply the delta and set the result.
  socket.current.on("event", function (update) {
    update = JSON5.parse(update);
    applyDelta(state, update.delta);
    setResult({
      processing: update.processing,
      state: state,
      events: update.events,
    });
  });
};

/**
 * Upload files to the server.
 *
 * @param state The state to apply the delta to.
 * @param setResult The function to set the result.
 * @param handler The handler to use.
 * @param endpoint The endpoint to upload to.
 */
export const uploadFiles = async (state, setResult, handler) => {
  const files = state.files;

  // return if there's no file to upload
  if (files.length == 0) {
    return false;
  }

  const headers = {
    "Content-Type": files[0].type,
  };
  const formdata = new FormData();

  // Add the token and handler to the file name.
  for (let i = 0; i < files.length; i++) {
    formdata.append(
      "files",
      files[i],
      getToken() + ":" + handler + ":" + files[i].name
    );
  }

  // Send the file to the server.
  await axios.post(UPLOADURL, formdata, headers).then((response) => {
    // Apply the delta and set the result.
    const update = response.data;
    applyDelta(state, update.delta);

    // Set processing to false and return.
    setResult({
      processing: false,
      state: state,
      events: update.events,
    });
  });

  return true;
};

/**
 * Create an event object.
 * @param name The name of the event.
 * @param payload The payload of the event.
 * @param use_websocket Whether the event uses websocket.
 * @param handler The client handler to process event.
 * @returns The event object.
 */
export const E = (name, payload = {}, handler = null) => {
  return { name, payload, handler };
};

/***
 * Check if a value is truthy in python.
 * @param val The value to check.
 * @returns True if the value is truthy, false otherwise.
 */
export const isTrue = (val) => {
  return Array.isArray(val) ? val.length > 0 : !!val;
};

/**
 * Prevent the default event for form submission.
 * @param event
 */
export const preventDefault = (event) => {
  if (event && event.type == "submit") {
    event.preventDefault();
  }
};

/**
 * Get the value from a ref.
 * @param ref The ref to get the value from.
 * @returns The value.
 */
export const getRefValue = (ref) => {
  if (ref.current.type == "checkbox") {
    return ref.current.checked;
  } else {
    return ref.current.value;
  }
}
