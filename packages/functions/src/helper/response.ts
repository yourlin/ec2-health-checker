export class ResponseHelper {
  static response(msg?: Object, statusCode?: number) {
    return {
      statusCode: statusCode ?? 200,
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        data: msg ?? 'OK',
        timestamp: Date.now()
      }),
    }
  }

  static responseOK(msg?: Object) {
    return ResponseHelper.response(msg)
  }

  static responseParameterError(msg?: Object) {
    return ResponseHelper.response(msg ?? 'ParameterError', 500)
  }

  static responseError(msg?: Object, statusCode?: number) {
    return ResponseHelper.response(msg ?? 'Error', statusCode ?? 500)
  }
}