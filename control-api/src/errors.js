'use strict';
class ControlError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, {status, code}); }
}
module.exports = {ControlError};
