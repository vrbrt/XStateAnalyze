package com.acme.orders;

import com.acme.orders.generated.InvoicesApi;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class InvoiceController implements InvoicesApi {
  private final OrderService orderService;

  public InvoiceController(OrderService orderService) { this.orderService = orderService; }

  @Override
  public ResponseEntity<Invoice> createInvoice(InvoiceRequest request) {
    return ResponseEntity.ok(orderService.invoice(request.userId()));
  }
}
