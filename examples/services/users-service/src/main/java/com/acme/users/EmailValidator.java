package com.acme.users;

import org.springframework.stereotype.Component;

@Component
public class EmailValidator implements UserValidator {
  @Override
  public void validate(UserDto dto) {
    if (!dto.getEmail().contains("@")) throw new IllegalArgumentException("email");
  }
}
