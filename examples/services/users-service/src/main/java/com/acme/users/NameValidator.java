package com.acme.users;

import org.springframework.stereotype.Component;

@Component
public class NameValidator implements UserValidator {
  @Override
  public void validate(UserDto dto) {
    if (dto.getName() == null) throw new IllegalArgumentException("name");
  }
}
