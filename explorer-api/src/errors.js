'use strict';

class ApiError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

class ArtifactStoreError extends ApiError {
  constructor(status, code, message, options = {}) {
    super(status, code, message, options);
    this.name = 'ArtifactStoreError';
  }
}

module.exports = {ApiError, ArtifactStoreError};
