
class AsyncHandler:
    tx_callback = None
    def rx(self, data: bytes) -> bytes:
        pass
    def tx(self, data: bytes) -> bytes:
        if self.tx_callback:
            return self.tx_callback(data)
        else:
            pass
    def set_tx_callback(self, callback):
        self.tx_callback = callback

def AsyncConnector( handler1: AsyncHandler, handler2: AsyncHandler):
    handler1.set_tx_callback(handler2.rx)
    handler2.set_tx_callback(handler1.rx)

def AsyncConectorSingle( dataFrom: AsyncHandler, dataTo: AsyncHandler):
    dataFrom.set_tx_callback(dataTo.rx)
