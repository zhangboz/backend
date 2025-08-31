// backend/services/eventService.mjs
import { EventEmitter } from 'events';

class AdminStatusEmitter extends EventEmitter {}

const adminStatusEmitter = new AdminStatusEmitter();

export default adminStatusEmitter;