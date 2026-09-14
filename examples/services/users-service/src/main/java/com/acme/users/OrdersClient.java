package com.acme.users;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import com.acme.generated.billing.BillingApi;
import com.acme.generated.billing.model.InvoiceRequest;

@Component
public class OrdersClient {
  private final RestTemplate restTemplate;
  private final WebClient ordersWebClient;
  private final BillingApi billingApi;

  @Value("${orders.base-url}")
  private String ordersBaseUrl;

  public OrdersClient(RestTemplate restTemplate, WebClient ordersWebClient, BillingApi billingApi) {
    this.restTemplate = restTemplate;
    this.ordersWebClient = ordersWebClient;
    this.billingApi = billingApi;
  }

  public int countOrders(Long userId) {
    OrderSummary[] orders = restTemplate.getForObject(ordersBaseUrl + "/orders?user=" + userId, OrderSummary[].class);
    return orders == null ? 0 : orders.length;
  }

  public OrderSummary getOrder(String id) {
    return ordersWebClient.get().uri("/orders/{id}", id).retrieve().bodyToMono(OrderSummary.class).block();
  }

  public void invoice(Long userId) {
    billingApi.createInvoice(new InvoiceRequest().userId(userId));
  }
}
